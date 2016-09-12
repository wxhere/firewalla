#!/usr/bin/env node

/*    Copyright 2016 Rottiesoft LLC 
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

// TODO Need to check argument, a null appid work ... shouldn't
'use strict';
var fs = require('fs');
var cloud = require('../encipher');
var intercomm = require('../lib/intercomm.js');
var Sensor = require('../lib/Sensor.js');

var debugging = false;
var log = function () {
    if (debugging) {
        console.log(Array.prototype.slice.call(arguments));
    }
};

var redis = require("redis");
var rclient = redis.createClient();



module.exports = class {
    // config is the controller json file + the controller section of fullConfig
    constructor(config, fullConfig, eptcloud, groups, gid, debug) {
        this.type = config.controller.type;
        this.id = eptcloud.eid + "." + config.controller.id;
        this.name = config.controller.name;

        this.config = config;
        this.groups = groups;
        this.eptcloud = eptcloud;
        this.eid = eptcloud.eid;
        this.primarygid = gid;
        this.groupsdb = {};
        this.intercommDevices = {};
        this.devicesdb = [];
        this.defaultDevice = null;
        this.sensordb = {}; // DB of {eid: {sensor:{ timestamp: 0, last}
        this.capabilitydb = {};

        this._txQueue = [];
        this._txQueueTxing = false;

        this.compress = true; // if this is on, if last msg send is same ... don't send

        console.log("Initializeing Controller ", this.name, this.type, this.id);

        debugging = true;
        log("Processing Config: ", config, fullConfig, gid, debug);
        console.log("########## Groups Counter : ", groups.length, gid);
        for (let g in groups) {
            let group = groups[g];
            console.log("########## Processing Groups : ", group);
            //if (group['me'] == null || group['me']['disiplayName'] == null) {
            if (group.me == null) {
                /*
                if (groups[g]['me'] == null) {
                    log("Group Error: ",groups[g]['me']);
                } else if (groups[g]['me']['displayName'] == null) {
                    log("Group Error 2: ",groups[g]['me']);
                }
              */
                continue;
            }
            log("GROUP ID: ", group.gid, " Known as: ", group.me.displayName);
            console.log("Group ID: ", groups[g].gid, " Known as: ", groups[g].me.displayName);
            this.groupsdb[group['gid']] = group;
            if (fullConfig.listen == "all" || group.gid == gid) {
                log("Listening to group ", group.gid, groups[g].name, "members count", group['symmetricKeys'].length);
                if (group['symmetricKeys'].length > 2) {
                    this.tx(group['gid'], "Please use @" + group.me.displayName + " to talk to me");
                }
                eptcloud.pullMsgFromGroup(groups[g].gid, 4, (e, r) => {
                    //console.log(" - ----- Received :",r.length," msgs",r);
                    let myname = groups[g].me.displayName;
                    if (e == null && r != null && r.length > 0) {
                        for (let i = 0; i < r.length; i++) {
                            let lmsg = r[i].message.msg.toLowerCase();
                            if (lmsg.indexOf('@' + myname) == -1 && group['symmetricKeys'].length > 2) {
                                continue;
                            }
                            let msg = r[i].message.msg.toLowerCase();
                            this.msgHandler(group.gid, r[i]);
                        }
                    }
                });
            }
        }
        if (config.intercomm) {
            intercomm.discover(null, ['devhi', 'devinfo'], (type, name, txt) => {
                //console.log("---------------------------------------");
                //console.log(type,name,txt);
                if (type == 'devinfo') {
                    log("Adding device to devices", name, this.intercommDevices);
                    this.intercommDevices[name] = txt;
                    this.discoveredHandler(type, name, txt);
                }
            });
        }

        // initialize devices 
        if (config.script) {

        }

        log("ConfigDevices", config.controller);

        if (config.controller.devices) {
            for (let i in config.controller.devices) {
                let deviceConfig = config.controller.devices[i];
                log("Creating device ", deviceConfig);
                if (deviceConfig.driver) {
                    let deviceObj = require('../devices/' + deviceConfig.driver);
                    let device = new deviceObj(this, deviceConfig, debug);
                    if (device) {
                        this.devicesdb.push(device);
                    }
                    if (this.defaultDevice == null) {
                        log("Default device set");
                        this.defaultDevice = device;
                    }
                }
            }
        }

        process.on('encipherSensorUpdate', (sensor, oldvalue, timestamp) => {
            console.log("Sensor Changed", sensor, oldvalue, timestamp);
            if (sensor.private == null) {
                if (this.sensordb == null) {
                    this.sensordb = {};
                }

                this.sensordb[sensor.id] = sensor;

                /*
                this.mysensordb[sensor.type][sensor.id]= {'type':sensor.type, 'sid':sensor.id, 'timestamp':sensor.timestamp,'value':sensor.value, 'unit':sensor.unit};
                */

                //this.sensorHandler(gid,eid,sid,sensor,value,unit,timestamp);
                //if (publish) {
                // }
                if (sensor.external == null) {
                    this.publish(this.primarygid, this.eid);
                }
            }
        });

        rclient.hmset("sys:ept", {
            eid: this.eid,
            token: eptcloud.token
        }, (err, data) => {
            if (err) {}
            console.log("Set SYS:EPT", err, data);
        });
    }


    // to be build by the controller bot
    /* Discovered info may be encrypted, if it is, the info field will contain the
       gid field, the key to unlock will be the gid key
sample:

devinfo eph:devinfo:D9uJgjY_qnYpi7_Had6lAA { gid: '6a755fde-f2a9-4070-90b1-376f458b456e',
  eid: 'D9uJgjY_qnYpi7_Had6lAA',
  device: 'camera',
  location: 'null',
  timestamp: '1461289668.499',
  info: 
   { vstream: { ip: '192.168.2.109', uri: '/stream.m3u8', port: 8080 },
     sensor: { 'sensortype':[Object]  }
    */
    discoveredHandler(type, name, txt) {
        console.log("##########", type, name, txt);
        if (txt && txt.info && type === 'devinfo' && txt.info.sensor != null) {
            let sensor = txt.info.sensor;
            for (let key in sensor) {
                let ss = sensor[key];
                console.log("Discovered : ", ss);
                let externalSensor = new Sensor(null, {
                    'gid': txt.gid,
                    'eid': txt.eid,
                    'type': ss.type,
                    'value': ss.value,
                    'unit': ss.unit,
                    'id': ss.id,
                    'timestamp': ss.timestamp,
                    'name': ss.name,
                    'external': 1,
                }, debugging)
                this.sensordb[externalSensor.id] = externalSensor;
                //     this.sensorHandler(txt.gid, txt.eid, sid, key, ss.value, ss.unit, ss.timestamp)
            }
        }
    }

    msgHandler(gid, msg) {}

    // this is advertise locally or may be remotely like steaming addres ...
    addCapability(gid, eid, type, object, publish) {
        this.capabilitydb[type] = object;
        if (publish) {
            this.publish(gid, eid);
        }
    }

    publish(gid, eid) {
        if (Object.keys(this.sensordb).length > 0) {
            this.capabilitydb['sensor'] = [];
        }
        console.log("Sensor DB", this.sensordb);
        for (let i in this.sensordb) {
            this.capabilitydb['sensor'].push(this.sensordb[i].json());
        }
        console.log("Publishing ", this.capabilitydb);

        intercomm.publishInfo(gid, eid, null, this.config.type, null, this.capabilitydb, null);
    }

    // msg == type == video
    txFile(gid, thumb, file, msg, type, beepmsg, height, width) {
        var name = this.groupsdb[gid].me.displayName;
        this.eptcloud.sendFileToGroup(gid, msg, file, thumb, type, name, beepmsg, height, width, "", function (e, r) {
            if (e) {
                console.log("Error Sending file", e);
            } else {
                log("Success Sending", r);
            }
        });
    }

    txData(gid, msg, obj, type, beepmsg, whisper) {
        var name = this.groupsdb[gid].me.displayName;
        this.eptcloud.sendDataToGroup(gid, msg, obj, type, name, beepmsg, whisper, (e, r) => {
            if (e) {
                console.log("Error Sending data", e, JSON.stringify(msg).length);
            } else {
                console.log("Success Sending", r);
            }
        });
    }

    txHtml(gid, m, beepmsg) {
        var name = this.groupsdb[gid].me.displayName;
        this.eptcloud.sendHtmlToGroup(gid, m, beepmsg, name, (e, r) => {
            console.log("sending html", e, r);
        });
    }

    txQ(gid, m, beepmsg) {
        let msg = JSON.stringify({
            gid: gid,
            m: m,
            beepmsg: beepmsg
        });
        if (this._txQueue.indexOf(msg) > -1 && this.compress == true) {
            return;
        }
        this._txQueue.push(msg);
        this._txQ();
    }

    _txQ() {
        if (this._txQueueTxing == true) {
            return;
        }
        this._txQueueTxing = true;
        let p = this._txQueue.splice(0, 1)[0];
        if (p) {
            p = JSON.parse(p);
        }
        if (this.compress == true && this.lastmsg != null && p != null) {
            if (p.m == this.lastmsg.m && p.gid == this.lastmsg.gid) {
                this._txQueueTxing = false;
                this._txQ();
                setTimeout(() => {
                    this.lastmsg = null
                }, 3000);
                return;
            }
        }
        if (p != null) {
            var name = this.groupsdb[p.gid].me.displayName;
            setTimeout(() => {
                this.eptcloud.sendTextToGroup(p.gid, p.m, p.beepmsg, name, (e, r) => {
                    this._txQueueTxing = false;
                    this.lastmsg = p;
                    this._txQ();
                });
            }, 100);
        } else {
            this._txQueueTxing = false;
        }
    }


    tx(gid, m, beepmsg) {
        var name = this.groupsdb[gid].me.displayName;
        this.eptcloud.sendTextToGroup(gid, m, beepmsg, name, (e, r) => {
            console.log("sending text", e, r);
        });
    }
};
#!/bin/bash

#
#    Copyright 2017 Firewalla LLC 
# 
#    This program is free software: you can redistribute it and/or  modify
#    it under the terms of the GNU Affero General Public License, version 3,
#    as published by the Free Software Foundation.
# 
#    This program is distributed in the hope that it will be useful,
#    but WITHOUT ANY WARRANTY; without even the implied warranty of
#    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#    GNU Affero General Public License for more details.
#
#    You should have received a copy of the GNU Affero General Public License
#    along with this program.  If not, see <http://www.gnu.org/licenses/>.
#

SLEEP_INTERVAL=${SLEEP_INTERVAL:-1}
LOGGER=/usr/bin/logger

err() {
    msg="$@"
    echo "ERROR: $msg" >&2
}

get_value() {
    kind=$1
    case $kind in
        ip)
            /sbin/ip addr show dev eth0 | awk '/inet / {print $2}'| grep -v 169.254
            ;;
        gw)
            /sbin/ip route show dev eth0 | awk '/default via/ {print $3}'
            ;;
    esac
}

save_values() {
    r=0
    $LOGGER "Save working values of ip/gw/dns"
    for kind in ip gw
    do
        value=$(get_value $kind)
        [[ -n "$value" ]] || continue
        file=/var/run/saved_${kind}
        rm -f $file
        echo "$value" > $file || r=1
    done
    /bin/cp -f /etc/resolv.conf /var/run/saved_resolv.conf
    return $r
}

set_value() {
    kind=$1
    saved_value=$2
    case ${kind} in
        ip)
            /sbin/ip addr replace ${saved_value} dev eth0
            ;;
        gw)
            /sbin/route add default gw ${saved_value} eth0
            ;;
    esac
}

restore_values() {
    r=0
    $LOGGER "Restore saved values of ip/gw/dns"
    for kind in ip gw
    do
        file=/var/run/saved_${kind}
        [[ -e "$file" ]] || continue
        saved_value=$(cat $file)
        [[ -n "$saved_value" ]] || continue
        set_value $kind $saved_value || r=1
    done
    if [[ -e /var/run/saved_resolv.conf ]]; then
        /bin/cp -f /var/run/saved_resolv.conf /etc/resolv.conf
    else
        r=1
    fi
    return $r
}

ethernet_connected() {
    carrier=$(cat /sys/class/net/eth0/carrier)
    test $carrier -eq 1
}

ethernet_ip() {
    eth_ip=$(ifconfig eth0 | awk '/inet addr/ {print $2}'| cut -f2 -d:)
    if [[ -n "$eth_ip" ]]; then
        if [[ ${eth_ip:0:8} == '169.254.' ]]; then
            return 1
        else
            return 0
        fi
    else
        return 1
    fi
}

gateway_pingable() {
    gw=$(ip route show dev eth0 | awk '/default/ {print $3; exit; }')
    if [[ -n "$gw" ]]; then
        ping -c1 -w3 $gw >/dev/null
    else
        return 1
    fi
}

dns_resolvable() {
    host -W3 github.com >/dev/null
}

github_api_ok() {
    curl -L -m3 https://api.github.com/zen &> /dev/null
}

if [[ $(id -u) != $(id -u root) ]]; then
    err "Only root can run this script"
    exit 1
fi

restored=0

echo -n "checking ethernet connection ... "
tmout=99999
while ! ethernet_connected ; do
    if [[ $tmout -gt 0 ]]; then
        (( tmout-- ))
    else
        echo "fail - reboot"
        reboot
    fi
    sleep 1
done
echo OK

echo -n "checking ethernet IP ... "
tmout=15
while ! ethernet_ip ; do
    if [[ $tmout -gt 0 ]]; then
        (( tmout-- ))
    else
        echo "fail - restore"
        $LOGGER "failed to get IP, restore network configurations"
        restore_values
        restored=1
        break
    fi
    sleep 1
done
echo OK

while true; do
    echo -n "checking gateway ... "
    tmout=15
    while ! gateway_pingable; do
        if [[ $tmout -gt 0 ]]; then
            (( tmout-- ))
        else
            if [[ $restored -eq 0 ]]; then 
                echo "fail - restore"
                $LOGGER "failed to ping gateway, restore network configurations"
                restore_values
                restored=1
                break;
            else
                echo "fail - reboot"
                $LOGGER "failed to ping gateway, even after restore, reboot"
                reboot
            fi
        fi
        sleep 1
    done
    [[ $restored -eq 1 ]] && continue
    echo OK

    echo -n "checking DNS ... "
    tmout=15
    while ! dns_resolvable; do
        if [[ $tmout -gt 0 ]]; then
            (( tmout-- ))
        else
            if [[ $restored -eq 0 ]]; then 
                echo "fail - restore"
                $LOGGER "failed to resolve DNS, restore network configurations"
                restore_values
                restored=1
                break
            else
                echo "fail - reboot"
                $LOGGER "failed to resolve DNS, even after restore, reboot"
                reboot
            fi
        fi
        sleep 1
    done
    [[ $restored -eq 1 ]] && continue
    echo OK

    echo -n "checking github REST API ... "
    tmout=15
    while ! github_api_ok; do
        if [[ $tmout -gt 0 ]]; then
            (( tmout-- ))
        else
            if [[ $restored -eq 0 ]]; then 
                echo "fail - restore"
                $LOGGER "failed to reach github API, restore network configurations"
                restore_values
                restored=1
                break
            else
                $LOGGER "failed to reach github API, even after restore, reboot"
                echo "fail - reboot"
                reboot
            fi
        fi
        sleep 1
    done
    [[ $restored -eq 1 ]] && continue
    echo OK
    break

done

save_values

exit $rc
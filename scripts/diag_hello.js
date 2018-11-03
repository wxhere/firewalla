'use strict'

const fwDiag = require("../extension/install/diag.js");

(async () => {
  try {
    await fwDiag.sayHello();
  } catch(err) {
    console.log("Failed to say hello:", err);
  }
  process.exit(0);
})();

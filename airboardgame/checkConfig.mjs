import fetch from "node-fetch";
import dotenv from "dotenv";
import { io } from "socket.io-client";
import fs from "fs";

dotenv.config();
dotenv.config({ path: "backend/.env" });

const siteId = process.env.VITE_RICOCHET_SITEID;
const socketURL = process.env.VITE_SOCKET_URL;
const socketPath = process.env.VITE_SOCKET_PATH || "/socket.io";
const apiEndpoint = process.env.VITE_API_ENDPOINT;
const fileStore = process.env.FILE_STORE_BACKEND;
const jsonStore = process.env.JSON_STORE_BACKEND;

const check = async () => {
  if (!siteId) {
    console.log(
      "🚨 You must define a VITE_RICOCHET_SITEID environment variable."
    );
    process.exit(1);
  }

  try {
    const result = await fetch(`${apiEndpoint}/${siteId}/`);
    // console.log(result);
    if (result.status !== 400) {
      console.log(
        "🚨 The Ricochet.js server doesn't respond correctly. " +
          `Have you started it? Tested url: ${apiEndpoint}`
      );
      return;
    }
    const data = await result.json();

    if (!data.message.includes("X-Ricochet-Origin")) {
      console.log(
        "🚨 The Ricochet.js server doesn't respond correctly. " +
          `Have you started it? Tested url: ${apiEndpoint}`
      );
      return;
    }

    const patch = await fetch(`${apiEndpoint}/_register/${siteId}`, {
      method: "PATCH",
    });

    if (patch.status === 404) {
      console.log(
        `🚨 The '${siteId}' doesn't seem to exists on Ricochet.js. ` +
          "Have you registered it?"
      );
      return;
    }

    if (patch.status === 400) {
      console.log(
        `✅ Ricochet.js is running and site ${siteId} seems to be registered.`
      );
    }
  } catch (e) {
    if (e.code === "ECONNREFUSED") {
      console.log(
        "🚨 The Ricochet.js server doesn't seem to be up and running. " +
          `Have you started it? Tested url: ${apiEndpoint}`
      );
      return;
    }
  }

  if (!fs.existsSync("./public/ricochet.json")) {
    console.log(
      "🚨 The './public/ricochet.json' file is missing. " +
        "Have you generated it? \nHint: from backend/ dir execute `npm run watch`"
    );
    return;
  }

  if (jsonStore === "memory") {
    console.log(
      "⚠️ The Ricochet.js JSON store is in memory. " +
        "Remember that you'll lost all changes and registered sites each time you stop the server."
    );
  }

  if (fileStore === "memory") {
    console.log(
      "⚠️ The Ricochet.js File store is in memory. " +
        "Remember that you'll lost all files each time you stop the server."
    );
  }

  const testConn = new Promise((resolve, reject) => {
    const socket = io(socketURL, {
      transports: ["websocket"],
      path: socketPath,
    });

    const out = setTimeout(() => {
      reject("failed");
      socket.disconnect();
    }, 5000);

    socket.on("connect", () => {
      resolve("ok");
      clearTimeout(out);
      socket.disconnect();
    });
  });

  try {
    await testConn;
    console.log("✅ Wire.io server is up and running.");
  } catch (e) {
    console.log(
      "🚨 The Wire.io server hasn't responded in 5s. " +
        `Have you started it? Tested url: ${socketURL}${socketPath}`
    );
    return;
  }

  console.log(
    "\n👏 Congrats, everything works fine!\n\nDo you still have an issue? Go to discord channel for more help."
  );
};

check();

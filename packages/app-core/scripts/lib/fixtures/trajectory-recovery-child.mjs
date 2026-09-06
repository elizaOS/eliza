/** Relays test commands across real child IPC without replacing the coordinator. */
process.on("message", (message) => {
  if (message?.qa === "send") {
    process.send(message.payload);
  } else if (message?.type?.startsWith("eliza:trajectory-recovery:")) {
    process.send({ qa: "received", payload: message });
  }
});
process.send({ qa: "ready" });

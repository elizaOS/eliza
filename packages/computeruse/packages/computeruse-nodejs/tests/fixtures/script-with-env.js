// Browser script that uses injected env object
(() => {
  // env object should be auto-injected by wrapper
  if (typeof env === "undefined") {
    throw new Error("env not injected");
  }

  if (!env.column_positions) {
    throw new Error("column_positions not in env");
  }

  return {
    positions: env.column_positions,
    count: env.column_positions.length,
  };
})();

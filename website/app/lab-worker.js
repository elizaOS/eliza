var cash = 10;
var pos = null;
var journal = [];
function tick() {
  var price = 100 + Math.sin(Date.now() / 20000) * 1.5;
  var fee = 0.003;
  var slip = price * 0.001;
  var line = "";
  if (!pos && Math.random() > 0.5) {
    pos = { entry: price + slip, size: 0.2 };
    cash -= fee;
    line = "SIMULATED buy 0.2 at " + pos.entry.toFixed(2) + " after slippage and a fee.";
  } else if (pos) {
    var exit = price - slip;
    var pnl = (exit - pos.entry) * pos.size - fee;
    cash += pnl;
    line = "SIMULATED sell. Marked result " + pnl.toFixed(4) + ". Not a real fill.";
    pos = null;
  } else {
    line = "SIMULATED hold. No order sent.";
  }
  journal.push({ at: new Date().toISOString(), line: line, cash: cash });
  if (journal.length > 40) journal.shift();
  postMessage({ line: line, cash: cash, journal: journal });
}
setInterval(tick, 12000);
tick();

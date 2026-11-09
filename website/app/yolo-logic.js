(function (root, factory) {
  var logic = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = logic;
  root.ValhallaYoloLogic = logic;
})(typeof self !== "undefined" ? self : this, function () {
  function signal(series, threshold) {
    if (!Array.isArray(series) || series.length < 2) return "wait";
    var first = Number(series[0]);
    var last = Number(series[series.length - 1]);
    var minMove = Number(threshold);
    if (!Number.isFinite(first) || first <= 0 || !Number.isFinite(last) || last <= 0) return "wait";
    if (!Number.isFinite(minMove) || minMove < 0) return "wait";
    var move = (last - first) / first;
    if (move >= minMove) return "momentum-up";
    if (move <= -minMove) return "momentum-down";
    return "flat";
  }

  return { signal: signal };
});

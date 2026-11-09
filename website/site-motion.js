(function () {
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function startHero() {
    var hero = document.querySelector("[data-motion-hero]");
    if (!hero || reduceMotion.matches) return;
    hero.classList.add("motion-start");
  }

  function revealGroups() {
    var groups = Array.prototype.slice.call(document.querySelectorAll("[data-motion-group]"));
    if (!groups.length || reduceMotion.matches || !("IntersectionObserver" in window)) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var items = entry.target.querySelectorAll(".blocks article, .steps article, .features article, .price");
        Array.prototype.forEach.call(items, function (item, index) {
          item.style.setProperty("--reveal-delay", Math.min(index, 4) * 42 + "ms");
          item.classList.add("motion-reveal");
        });
        observer.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });

    groups.forEach(function (group) { observer.observe(group); });
  }

  function boot() {
    startHero();
    revealGroups();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

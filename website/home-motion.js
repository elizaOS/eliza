(function () {
  var scene = document.getElementById("hero-scene");
  var video = document.getElementById("hero-video");
  var toggle = document.getElementById("hero-motion");
  if (!scene || !video || !toggle) return;

  var reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  var sourcesReady = false;

  function saveDataOn() {
    var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return !!(connection && connection.saveData);
  }

  function heldOff() {
    var queryOff = false;
    var stored = false;
    try {
      queryOff = new URLSearchParams(window.location.search).get("motion") === "0";
      stored = sessionStorage.getItem("valhalla-hero-paused") === "1";
    } catch (error) {
      queryOff = false;
    }
    return reduceQuery.matches || saveDataOn() || queryOff || stored;
  }

  function remember(paused) {
    try {
      if (paused) sessionStorage.setItem("valhalla-hero-paused", "1");
      else sessionStorage.removeItem("valhalla-hero-paused");
    } catch (error) {
      // Playback still works when storage is blocked.
    }
  }

  function attachSources() {
    if (sourcesReady) return;
    sourcesReady = true;
    var mp4 = document.createElement("source");
    mp4.src = "/media/hero.mp4";
    mp4.type = "video/mp4";
    video.appendChild(mp4);
    video.preload = "metadata";
    video.load();
  }

  function setPlaying(playing) {
    scene.classList.toggle("is-playing", playing);
    toggle.hidden = false;
    toggle.setAttribute("aria-pressed", playing ? "true" : "false");
    toggle.setAttribute("aria-label", playing ? "Pause motion" : "Play motion");
    toggle.title = playing ? "Pause motion" : "Play motion";
    toggle.textContent = playing ? "Ⅱ" : "▶";
  }

  function startMotion() {
    attachSources();
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    var pending = video.play();
    if (pending && typeof pending.then === "function") {
      pending.then(function () { setPlaying(true); }).catch(function () { setPlaying(false); });
    } else {
      setPlaying(!video.paused);
    }
  }

  function stopMotion() {
    video.pause();
    remember(true);
    setPlaying(false);
  }

  function showFallback() {
    var note = document.getElementById("hero-fallback");
    if (note) note.hidden = false;
    setPlaying(false);
  }

  var quietTimer;
  toggle.addEventListener("pointerdown", function () {
    toggle.classList.add("is-touched");
    clearTimeout(quietTimer);
    quietTimer = setTimeout(function () {
      if (document.activeElement !== toggle) toggle.classList.remove("is-touched");
    }, 2000);
  });
  toggle.addEventListener("click", function () {
    if (scene.classList.contains("is-playing")) stopMotion();
    else {
      remember(false);
      startMotion();
    }
  });
  video.addEventListener("error", showFallback);

  video.addEventListener("pause", function () { setPlaying(false); });
  video.addEventListener("playing", function () { setPlaying(true); });

  if (!heldOff()) startMotion();
  else setPlaying(false);

  if (typeof reduceQuery.addEventListener === "function") {
    reduceQuery.addEventListener("change", function () {
      if (reduceQuery.matches) stopMotion();
    });
  }

})();

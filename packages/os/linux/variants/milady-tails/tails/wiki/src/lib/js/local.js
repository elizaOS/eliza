document.addEventListener("DOMContentLoaded", function() {

  /* Toggle warnings */

  let warnings = ["identity", "tor", "computer"];

  function hideAllWarnings(evt) {
    warnings.forEach(function(element) {
      document.getElementById("detailed-" + element).classList.add("hidden");
      document.getElementById("detailed-" + element).style.maxHeight = null;
      document.getElementById("toggle-" + element).classList.remove("button-revealed");
    });

  }

  function toggleWarnings(warning, evt) {
    let elem = document.getElementById("detailed-" + warning);
    if (elem.classList.contains("hidden")) {
      hideAllWarnings(evt);
      elem.classList.remove("hidden");
      elem.style.maxHeight = elem.scrollHeight + "px";
      let btn = document.getElementById("toggle-" + warning);
      btn.classList.add("button-revealed")
    } else {
      hideAllWarnings(evt);
    }
  }

  warnings.forEach(warning => {
    let toggle = document.getElementById("toggle-" + warning);
    if(toggle) {
      toggle.onclick = function(e) { toggleWarnings(warning, e); }
    }
    let hide = document.getElementById("hide-" + warning);
    if(hide) {
      hide.onclick = function(e) { hideAllWarnings(e); }
    }
  });

  /* Change PNG images of class 'svg' to SVG images (#17805) */

  var svgs = document.getElementsByClassName("svg");
  for (let i = 0; i < svgs.length; i++) {
    svgs[i].src = svgs[i].src.replace(/\.png$/, '.svg');
  }

  /* Persist YEC banner close across pages */
  let trigger = document.querySelector("#banner-close-button");
  trigger.addEventListener("change", () => {
    sessionStorage.setItem("bannerClosed", trigger.checked);
  });
  if (sessionStorage.getItem("bannerClosed")) {
    trigger.checked = sessionStorage.getItem("bannerClosed");
  }

});

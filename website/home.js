(function () {
  var form = document.getElementById("home-email");
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    try {
      sessionStorage.setItem("valhalla-entry-email", document.getElementById("home-email-address").value.trim());
      sessionStorage.setItem("valhalla-entry-desk", "1");
    } catch (error) {
      document.getElementById("home-email-address").setCustomValidity("Browser storage is unavailable. Use the sign-in link instead.");
      document.getElementById("home-email-address").reportValidity();
      return;
    }
    window.location.assign("/app/");
  });
  document.getElementById("home-email-address").addEventListener("input", function (event) {
    event.target.setCustomValidity("");
  });
  document.getElementById("home-google").addEventListener("click", function () {
    try {
      sessionStorage.setItem("valhalla-entry-desk", "1");
    } catch (error) {
      // Sign-in remains available without the optional return preference.
    }
  });
})();

(function () {
  function remember(email) {
    try {
      if (email) sessionStorage.setItem('valhalla-entry-email', email);
      sessionStorage.setItem('valhalla-entry-desk', '1');
      return true;
    } catch (error) {
      return false;
    }
  }

  function enter(event, email, requireStorage) {
    if (event) event.preventDefault();
    if (!remember(email)) {
      var input = document.getElementById('home-email-address');
      if (requireStorage && input) {
        input.setCustomValidity('Browser storage is unavailable. Use the sign-in link instead.');
        input.reportValidity();
        return;
      }
    }
    window.location.assign('/app/');
  }

  var form = document.getElementById('home-email');
  if (form) {
    form.addEventListener('submit', function (event) {
      var input = document.getElementById('home-email-address');
      enter(event, input ? input.value.trim() : '', true);
    });
  }

  var typed = document.getElementById('home-email-address');
  if (typed) {
    typed.addEventListener('input', function (event) {
      event.target.setCustomValidity('');
    });
  }

  var links = document.querySelectorAll('[data-enter-desk]');
  Array.prototype.forEach.call(links, function (link) {
    link.addEventListener('click', function (event) {
      enter(event, '', false);
    });
  });
})();

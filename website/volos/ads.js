(function () {
  var slot = document.getElementById('valos-ad');
  if (!slot) return;
  var host = String(location.hostname || '').replace(/\.$/, '').toLowerCase();
  if (host !== 'valos.live' && host !== 'www.valos.live') return;
  var configured = window.VALHALLA_SITE && window.VALHALLA_SITE.ADSENSE_SLOT;
  var id = typeof configured === 'string' ? configured.trim() : '';
  if (!id) return;
  var unit = slot.querySelector('.adsbygoogle');
  if (unit) unit.setAttribute('data-ad-slot', id);
  slot.hidden = false;
  var script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6504655762357230';
  script.onload = function () {
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); }
    catch (error) { slot.hidden = true; }
  };
  document.head.appendChild(script);
})();

/* Renders offers.json. A row with an empty url stays a label, not a link. */
(function () {
  var LABEL = "Affiliate link · we may earn a commission";

  function track(id, placement) {
    if (!window.ValhallaConsent || !window.ValhallaConsent.allows("advertising")) return;
    var cfg = window.VALHALLA_SITE || {};
    var endpoint = cfg.OFFER_CLICK_URL || "";
    if (!endpoint || !/^[a-z0-9-]{1,40}$/.test(id)) return;
    fetch(endpoint, {
      method: "POST",
      mode: "cors",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: id, placement: placement }),
      keepalive: true
    }).catch(function () {});
  }

  function live(offer) {
    return offer && typeof offer.url === "string" && offer.url.indexOf("https://") === 0;
  }

  function fillFooter(offers) {
    var slot = document.getElementById("offer-footer");
    if (!slot) return;
    var row = offers.filter(function (offer) {
      return live(offer) && (offer.placements || []).indexOf("footer") >= 0;
    })[0];
    if (!row) return;
    var link = document.createElement("a");
    link.href = row.url;
    link.rel = "sponsored noopener noreferrer";
    link.target = "_blank";
    link.textContent = row.partner;
    link.addEventListener("click", function () { track(row.id, "footer"); });
    slot.appendChild(link);
    slot.appendChild(document.createTextNode(" · " + LABEL + ". Not trading advice."));
  }

  function fillTools(offers) {
    var list = document.getElementById("tool-list");
    if (!list) return;
    offers.forEach(function (offer) {
      var card = document.createElement("article");
      var title = document.createElement("h2");
      title.textContent = offer.partner + " — " + offer.title;
      var blurb = document.createElement("p");
      blurb.textContent = offer.blurb || "";
      card.appendChild(title);
      card.appendChild(blurb);
      if (live(offer)) {
        var link = document.createElement("a");
        link.href = offer.url;
        link.rel = "sponsored noopener noreferrer";
        link.target = "_blank";
        link.textContent = "Open " + offer.partner;
        link.addEventListener("click", function () { track(offer.id, "tools"); });
        var note = document.createElement("p");
        note.textContent = LABEL + ". Not trading advice.";
        card.appendChild(link);
        card.appendChild(note);
      } else {
        var wait = document.createElement("p");
        wait.textContent = "Link not set. This offer stays off until a URL is added.";
        card.appendChild(wait);
      }
      list.appendChild(card);
    });
  }

  function accepted(doc) {
    if (!doc || !window.ValhallaTrust || !window.nacl) return [];
    var offers = window.ValhallaTrust.verifyOffers(window.nacl, doc);
    return offers || [];
  }

  fetch(document.body.dataset.offers || "offers.json")
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (doc) {
      var offers = accepted(doc);
      fillFooter(offers);
      fillTools(offers);
    })
    .catch(function () {});
})();

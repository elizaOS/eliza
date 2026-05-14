document.addEventListener('DOMContentLoaded', function() {

  document.title = "Tails";

  var date = Date.now()
  var randomMessages = document.getElementsByClassName('random-message');
  for (let i = 0; i < randomMessages.length; i++) {
    var message = randomMessages[i]
    var offset = (message.dataset.displayOffset == null) ? 0 : Number(message.dataset.displayOffset);

    /* We divide the time since epoch by slots of 5 minutes. Each randomMessage
     * will be displayed during 5 minutes of each (1 / displayProbability) of
     * these 5-minutes slots.
     *
     * Reloading the page doesn't trigger more displays. */
    if((Math.round(date / 1000 / 60 / 5) + offset) % Math.round(1 / message.dataset.displayProbability) == 0) {
      message.style.display = "block";
    }

  }

});

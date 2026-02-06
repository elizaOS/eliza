# Air board game - the free online tabletop simulator

Join us on Discord - [![Discord](https://img.shields.io/discord/899259310620696616)](https://discord.gg/EsZGJ5h6UA)

If you just want to play, go [here](https://airboardgame.net).

* **Choose** a game
* **Share** the link with your friends
* **Play** together

Simple, fast and efficient.

No need to create an account, choose a game from the list ([or create yours](#game-designer-its-also-for-you)) share
the displayed link with your friends by mail or any channel you have in common
and wait for your friends to join you.

## A tabletop simulator ?

![In action](./public/screen.png)

Airboardgame is a tabletop simulator to play your favorite board games with your
friends online. It's not a game engine, it's just a tabletop simulator of what you can
do with a real table. You share a common space with other players like if you were is the same room.
If you move something or if you flip a card, other players see
this action and can respond in real time.

Hint: you really should use an audio conference application to speak with other players.

Airboardgame doesn't force you, you make the rules.
Airboardgame is just a game table simulator : what you would do with a real
table you can/must do it with Airboargame.

## Features for players

Flip card items.

![Load and save](./public/flip.gif)

Tap items.

![Load and save](./public/tap.gif)

Flip cards only for you, like hand cards.

![Load and save](./public/flipyou.gif)

See other players cursor on the shared board and how they move in real time.
You can show things, see what they are doing, …

![Load and save](./public/other.gif)

Save and restore game.

![Load and save](./public/loadsave.png)

and more…

## Game designer, it's also for you

Airboardgame is not only designed to play games but also to create them.
In just few minutes you can create simple games without any
development skills and play with your friends.

You want to test a concept? Try a print & play game? You can use Airboardgame
without the need for more hardware.

The only limit is your imagination.

To access this features, login then click on the « Create new game » button on home page.

We want Airboardgame to be simple, intuitive web application.
Just give a try and if you like it share it and contribute.

You can create a game with simple actions :

* Create items like
  * Round,
  * Rectangle,
  * Dice,
  * Note,
  * Counter,
  * Image that can represent cards, board, token, perks, …
  * Pre-made items
  * …
* Choose board size
* Add available items not on the board but in the "game box" like extension or material for more user.

You can drag'n'drop image from your desktop to the board to use them in Airboardgame.

## Technical details

* Open source web application,
* Made with React and Socket.io,
* Use Recoiljs as state management,
* Client to client driven architecture,
* Use Ricochet.js as backend framework.

## Developper documentation

* [Installation instructions](docs/dev.md)
* [Deploy your own instance](docs/dev.md)
* [Contributing guide](docs/dev.md)

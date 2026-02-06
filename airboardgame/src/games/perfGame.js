import { nanoid } from "nanoid";

const genGame = () => {
  const items = [...Array(2000)].map((e, index) => ({
    type: "rect",
    x: 10 + index,
    y: 10 + index,
    width: 100,
    height: 100,
    id: nanoid(),
  }));
  return {
    items,
    availableItems: [
      {
        groupId: "Group",
        label: "Rect",
        type: "rect",
        color: "#00D022",
        width: 80,
        height: 80,
      },
    ],
    board: {
      size: 4000,
      scale: 0.5,
      name: "Perf Game",
      published: true,
      keepTitle: true,
      translations: [
        {
          language: "fr",
          name: "1 Jeu test de performances et des extrêmes",
          baseline:
            "Un jeu pour tester les performances mais également les limites des différentes saisies. Le texte est tellement long qu'il doit être caché au final.",
        },
      ],
      playerCount: [1, 9],
      defaultName: "1 Performance game to test strange things and other",
      defaultLanguage: "en",
      defaultBaseline:
        "A very long baseline to show how it can going is someone wants to write a book.",
      materialLanguage: "Multi-lang",
      minAge: "10",
      duration: [30, 90],
      imageUrl: "/game_assets/default.png",
      gridSize: 1,
    },
    id: "perf",
  };
};

export const testGame = genGame();

export default testGame;

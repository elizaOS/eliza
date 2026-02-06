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
      name: "Unpublished Game",
      published: false,
      keepTitle: true,
      translations: [
        {
          language: "fr",
          name: "2 Jeu non publié",
          description: "Un jeu non publié pour tester",
        },
      ],
      playerCount: [1, 9],
      defaultName: "2 Unpublished Game",
      defaultLanguage: "en",
      defaultDescription: "A non published game",
      materialLanguage: "Multi-lang",
      minAge: "10",
      duration: [30, 90],
      imageUrl: "/game_assets/default.png",
      gridSize: 1,
    },
    id: "unpublished",
  };
};

export const unpublishedGame = genGame();

export default unpublishedGame;

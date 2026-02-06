const genGame = () => {
  const items = [];

  items.push({
    type: "image",
    content: "/game_assets/AS.jpg",
    backContent: "/game_assets/Red_back.jpg",
    text: "frontLabel",
    width: 100,
    x: 400,
    y: 400,
    actions: [
      "flip",
      "flipSelf",
      "tap",
      { name: "rotate", args: { angle: 25 } },
      "rotate45",
      "rotate90",
      "stack",
      "shuffle",
      "clone",
      "lock",
      "remove",
    ],
  });

  items.push({
    type: "image",
    content: "/game_assets/BH.jpg",
    backContent: "/game_assets/Red_back.jpg",
    text: "frontLabel",
    backText: "backLabel",
    width: 100,
    x: 410,
    y: 400,
  });

  items.push({
    type: "image",
    content: "/game_assets/JC.jpg",
    backContent: "/game_assets/Red_back.jpg",
    overlay: { content: "/game_assets/overlay.png" },
    width: 100,
    x: 420,
    y: 400,
  });

  items.push({
    type: "rect",
    color: "#00D022",
    width: 100,
    height: 100,
    x: 0,
    y: 0,
  });

  items.push({
    type: "rect",
    color: "#22D022",
    width: 80,
    height: 80,
    x: 10,
    y: 10,
  });

  items.push({
    type: "rect",
    color: "#ffffff",
    width: 80,
    height: 80,
    text: "test2",
    textColor: "#ccc",
    x: 400,
    y: 100,
  });

  items.push({
    type: "rect",
    color: "#000",
    width: 80,
    height: 80,
    text: "test4",
    textColor: "#ccc",
    x: 420,
    y: 120,
  });

  items.push({
    type: "round",
    color: "#D00022",
    text: "test",
    textColor: "#ccc",
    radius: 80,
    x: 500,
    y: 500,
  });

  items.push({
    type: "round",
    color: "#ffffff",
    radius: 80,
    text: "test3",
    textColor: "#ccc",
    x: 700,
    y: 400,
  });

  items.push({
    type: "round",
    color: "#000",
    radius: 80,
    text: "test4",
    textColor: "#ccc",
    x: 720,
    y: 400,
  });

  items.push({
    label: "Counter",
    type: "counter",
    color: "#D00022",
    x: 50,
    y: 50,
  });

  items.push({
    label: "Dice",
    type: "dice",
    color: "#D00022",
    x: 200,
    y: 50,
  });

  items.push({
    label: "Note",
    type: "note",
    x: 10,
    y: 200,
  });

  items.push({
    label: "My zone",
    type: "zone",
    layer: -1,
    width: 500,
    height: 300,
    locked: true,
    onItem: ["reveal"],
    x: 200,
    y: 600,
  });
  items.push({
    label: "My cube",
    type: "cube",
    size: 70,
    color: "#ff0000",
    x: 400,
    y: 550,
  });
  items.push({
    text: "My token",
    type: "token",
    size: 70,
    color: "#00ff00",
    x: 450,
    y: 600,
  });
  items.push({
    label: "My meeple",
    type: "meeple",
    size: 70,
    color: "#0000ff",
    x: 600,
    y: 650,
  });
  items.push({
    label: "My jewel",
    type: "jewel",
    size: 70,
    color: "#00ffff",
    x: 650,
    y: 550,
  });
  items.push({
    label: "My jewel",
    type: "jewel",
    size: 70,
    color: "#ff0000",
    x: 650,
    y: 600,
  });

  items.push({
    label: "Generator",
    type: "generator",
    layer: -1,
    x: 500,
    y: 700,
    item: {
      label: "My jewel",
      type: "jewel",
      size: 70,
      color: "#ff0000",
    },
  });

  return {
    items,
    availableItems: [
      {
        name: "Blue rect",
        label: "rect",
        type: "rect",
        color: "#0000D2",
        width: 80,
        height: 80,
      },
      {
        name: "First group",
        items: [
          {
            name: "Green rect",
            label: "rect",
            type: "rect",
            color: "#00D022",
            width: 80,
            height: 80,
          },
          {
            label: "Red rect",
            type: "rect",
            color: "#D00022",
            width: 80,
            height: 80,
          },
        ],
      },
      {
        name: "Second group",
        items: [
          {
            name: "Green pawn",
            label: "rect",
            type: "pawn",
            color: "#00D022",
            size: 80,
          },
          {
            name: "Red pawn",
            type: "pawn",
            color: "#D00022",
            size: 80,
          },
          {
            name: "blue pawn",
            type: "pawn",
            color: "#2000D2",
            size: 80,
          },
          {
            name: "Third nested group",
            items: [
              {
                name: "Green rect",
                label: "rect",
                type: "rect",
                color: "#00D022",
                width: 80,
                height: 80,
              },
              {
                name: "Red rect",
                type: "rect",
                color: "#D00022",
                width: 80,
                height: 80,
              },
            ],
          },
        ],
      },
      {
        name: "Green circle",
        label: "round",
        type: "round",
        color: "#00D022",
        size: 80,
      },
      {
        name: "Red circle",
        type: "round",
        color: "#D00022",
        size: 80,
      },
      {
        type: "image",
        content: "/game_assets/JC.jpg",
        backContent: "/game_assets/Red_back.jpg",
        overlay: { content: "/game_assets/overlay.png" },
        width: 100,
      },
    ],
    board: {
      size: 1000,
      scale: 1,
      name: "Test Game",
      published: true,
      keepTitle: true,
      translations: [
        {
          language: "fr",
          name: "0 Jeu test",
          description: "Un jeu pour tester",
          baseline: "Un jeu de test",
        },
      ],
      playerCount: [2, 4],
      defaultName: "0 Test game",
      defaultLanguage: "en",
      defaultDescription: "A classic",
      defaultBaseline: "A test game",
      materialLanguage: "Multi-lang",
      minAge: "10",
      duration: [30, 90],
      imageUrl: "/game_assets/default.png",
      gridSize: 1,
    },
    id: "test",
  };
};

export const testGame = genGame();

export default testGame;

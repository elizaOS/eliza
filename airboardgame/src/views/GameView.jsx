import React from "react";
import { useTranslation } from "react-i18next";
import useAsyncEffect from "use-async-effect";
import { BoardWrapper } from "react-sync-board";
import { useNavigate } from "react-router-dom";
import { useSocket } from "@scripters/use-socket.io";

import { itemTemplates, itemLibrary, premadeItems } from "../gameComponents";
import Waiter from "../ui/Waiter";

import BoardView from "./BoardView";
import { getOrCreateGame } from "../utils/api";
import { uid } from "../utils";

import useGame, { GameProvider } from "../hooks/useGame";
import { GlobalConfProvider } from "../hooks/useGlobalConf";

// Keep compatibility with previous availableItems shape
const migrateAvailableItemList = (old) => {
  const groupMap = old.reduce((acc, { groupId, ...item }) => {
    if (!acc[groupId]) {
      acc[groupId] = [];
    }
    acc[groupId].push(item);
    return acc;
  }, {});
  return Object.keys(groupMap).map((name) => ({
    name,
    items: groupMap[name],
  }));
};

const adaptItem = (item) => ({
  type: item.type,
  template: item,
  component: itemTemplates[item.type].component,
  name: item.name || item.label || item.text || itemTemplates[item.type].name,
  uid: uid(),
});

const adaptItems = (nodes) => {
  return nodes.map((node) => {
    if (node.type) {
      return adaptItem(node);
    } else {
      return { ...node, items: adaptItems(node.items) };
    }
  });
};

const newGameData = (translate) => ({
  items: [
    {
      label: translate("Welcome to AirBoardGame Studio!"),
      type: "note",
      value:
        translate(
          "To add new items, click on the plus button located on the left sidebar.\n\n"
        ) +
        translate(
          "To edit an item, click on it and then click on the pen icon at the bottom of the screen.\n\n"
        ) +
        translate(
          "You can configure the game title and other settings by clicking on the gear icon in the left sidebar. From there, you can also choose to make your game public.\n\n"
        ) +
        translate(
          "Don't forget to save your game using the save button located in the middle of the left sidebar.\n\n"
        ) +
        translate(
          "Have fun exploring the possibilities and enjoy the process of game creation!"
        ),
      x: 0,
      y: 0,
      width: 400,
      height: 500,
    },
  ],
  availableItems: [],
  board: {
    size: 2000,
    scale: 1,
    imageUrl: { type: "external", content: "/game_assets/default.png" },
    neverSaved: true,
    defaultName: translate("New game"),
  },
});

export const GameView = () => {
  const [gameLoaded, setGameLoaded] = React.useState(false);
  const { setGame, gameId, availableItems } = useGame();

  const gameLoadingRef = React.useRef(false);

  const { t } = useTranslation();

  useAsyncEffect(
    async (isMounted) => {
      if (!gameLoaded && !gameLoadingRef.current) {
        gameLoadingRef.current = true;
        // Load game from server
        const gameData = await getOrCreateGame(gameId, newGameData(t));

        if (!isMounted) return;

        setGame(gameData);
        setGameLoaded(true);
      }
    },
    [gameLoaded]
  );

  const itemLibraries = React.useMemo(() => {
    let itemList = availableItems;
    if (itemList.length && itemList[0].groupId) {
      itemList = migrateAvailableItemList(itemList);
    }
    const availableItemLibrary = adaptItems(itemList);
    const premadeLibrary = adaptItems(premadeItems);

    const libraries = [
      {
        name: t("Standard"),
        key: "standard",
        items: itemLibrary,
      },
      {
        name: t("Premade"),
        key: "premade",
        items: premadeLibrary,
      },
    ];

    if (availableItems.length) {
      libraries.push({
        name: t("Box"),
        key: "box",
        items: availableItemLibrary,
      });
    }
    return libraries;
  }, [availableItems, t]);

  const mediaLibraries = React.useMemo(() => {
    return [{ id: "game", name: t("Game"), boxId: "game", resourceId: gameId }];
  }, [gameId, t]);

  if (!gameLoaded) {
    return <Waiter />;
  }

  return (
    <GlobalConfProvider editMode={true}>
      <BoardView
        mediaLibraries={mediaLibraries}
        itemLibraries={itemLibraries}
        edit={true}
      />
    </GlobalConfProvider>
  );
};

const ConnectedGameView = ({ gameId }) => {
  const socket = useSocket();
  const [sessionId] = React.useState(uid());
  const navigate = useNavigate();

  React.useEffect(() => {
    if (!gameId) {
      const newGameId = uid();
      navigate(`/game/${newGameId}/`);
    }
  }, [gameId, navigate]);

  if (!gameId) {
    return <Waiter />;
  }

  return (
    <BoardWrapper
      room={`room_${sessionId}`}
      session={sessionId}
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
      }}
      socket={socket}
      LoadingComponent={() => <Waiter />}
    >
      <GameProvider gameId={gameId}>
        <GameView create={!gameId} />
      </GameProvider>
    </BoardWrapper>
  );
};

export default ConnectedGameView;

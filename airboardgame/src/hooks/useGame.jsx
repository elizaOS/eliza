import React, { useContext } from "react";

import { updateGame } from "../utils/api";

import { useBoardConfig, useItemActions } from "react-sync-board";

export const GameContext = React.createContext({});

export const GameProvider = ({ gameId, game, children }) => {
  const { setItemList, getItemList } = useItemActions();
  const [availableItems, setAvailableItems] = React.useState([]);
  const [boardConfig, setBoardConfig] = useBoardConfig();

  const [gameLoaded, setGameLoaded] = React.useState(false);

  const setGame = React.useCallback(
    async (newGame) => {
      const { availableItems, items, board } = newGame;
      setAvailableItems(availableItems);
      // The filter prevent the empty item bug on reload
      setItemList(items.filter((item) => item));
      setBoardConfig(board, false);
      setGameLoaded(true);
    },
    [setBoardConfig, setItemList]
  );

  const getCurrentGame = React.useCallback(async () => {
    const currentGame = {
      items: getItemList(),
      board: boardConfig,
      availableItems,
    };
    return currentGame;
  }, [availableItems, boardConfig, getItemList]);

  const saveGame = React.useCallback(async () => {
    const currentGame = await getCurrentGame();
    delete currentGame.neverSaved;
    return updateGame(gameId, currentGame);
  }, [gameId, getCurrentGame]);

  React.useEffect(() => {
    if (game) {
      setGame(game);
    }
  }, [game, setGame]);

  React.useEffect(() => {
    window.debugShowGame = () => {
      console.log(getItemList());
    };
  }, [getItemList]);

  return (
    <GameContext.Provider
      value={{
        setGame,
        getGame: getCurrentGame,
        saveGame,
        gameLoaded,
        gameId,
        availableItems,
      }}
    >
      {children}
    </GameContext.Provider>
  );
};

export const useGame = () => {
  return useContext(GameContext);
};

export default useGame;

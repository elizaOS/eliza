import React, { useContext } from "react";
import {
  useItemActions,
  useMessage,
  useBoardConfig,
  useSessionInfo,
} from "react-sync-board";
import { useTranslation } from "react-i18next";

import { updateSession, getSession, getGame } from "../utils/api";

import demoEn from "../games/demo_en.json?url";
import demoFr from "../games/demo_fr.json?url";

export const SessionContext = React.createContext({});

const demos = {
  fr: demoFr,
};

const emptyBoard = {
  items: [],
  availableItems: [],
  board: {
    translations: [
      {
        language: "fr",
        name: "Choisissez un jeu",
        description: "...",
      },
    ],
    defaultName: "Choose a game",
    defaultLanguage: "en",
    defaultDescription: "...",
    gridSize: 1,
  },
};

export const SessionProvider = ({
  sessionId,
  fromGameId,
  isVassalSession,
  children,
}) => {
  const { i18n } = useTranslation();
  const { messages, setMessages } = useMessage();
  const { setItemList, getItemList } = useItemActions();
  const [boardConfig, setBoardConfig] = useBoardConfig();

  const [sessionLoaded, setSessionLoaded] = React.useState(false);
  const [currentGameId, setCurrentGameId] = React.useState(fromGameId);

  const { sessionInfo, updateSessionInfo } = useSessionInfo();

  const setAvailableItems = React.useCallback(
    (newAvailableItems) => {
      updateSessionInfo({ availableItems: newAvailableItems });
    },
    [updateSessionInfo]
  );

  const availableItems = React.useMemo(() => sessionInfo.availableItems || [], [
    sessionInfo.availableItems,
  ]);

  const loadSession = React.useCallback(async () => {
    let sessionData;

    // Init session from server
    try {
      // First from session if exists
      sessionData = await getSession(sessionId);
      const sessionGameId = sessionData.gameId;

      // Update availableItems from original game
      if (sessionGameId) {
        const { availableItems } = await getGame(sessionGameId);
        sessionData.availableItems = availableItems;
        setCurrentGameId(sessionGameId);
      }
    } catch {
      if (fromGameId) {
        // Then from initial game
        if (fromGameId === "demo") {
          const foundLang = i18n.languages.find((lang) => demos[lang]);
          if (foundLang) {
            sessionData = await (await fetch(demos[foundLang])).json();
          } else {
            sessionData = await (await fetch(demoEn)).json();
          }
        } else {
          sessionData = await getGame(fromGameId);
        }
      } else {
        // Empty board
        sessionData = emptyBoard;
      }
    }
    return sessionData;
  }, [fromGameId, i18n.languages, sessionId]);

  const setSession = React.useCallback(
    async (newData) => {
      const { availableItems, items, board, messages = [] } = newData;
      setAvailableItems(availableItems);
      // The filter prevents the empty item bug or missing type on reload
      setItemList(items.filter((item) => item && item.type));
      setBoardConfig(board);
      setMessages(messages);
      updateSessionInfo({ loaded: true });
      setSessionLoaded(true);
    },
    [
      setAvailableItems,
      setBoardConfig,
      setItemList,
      setMessages,
      updateSessionInfo,
    ]
  );

  const getCurrentSession = React.useCallback(async () => {
    const currentSession = {
      items: await getItemList(),
      board: boardConfig,
      availableItems: availableItems,
      messages: messages.slice(-50),
      timestamp: Date.now(),
      gameId: fromGameId,
    };

    return currentSession;
  }, [availableItems, boardConfig, fromGameId, getItemList, messages]);

  const changeGame = React.useCallback(
    async (newGameId) => {
      const newGame = await getGame(newGameId);
      const currentSession = getCurrentSession();

      setSession({ ...currentSession, ...newGame }, true);
    },
    [getCurrentSession, setSession]
  );

  const saveSession = React.useCallback(
    async (force) => {
      const currentSession = await getCurrentSession();

      if (currentSession.items.length || force) {
        try {
          return await updateSession(sessionId, currentSession);
        } catch (e) {
          console.log(e);
        }
      }
    },
    [getCurrentSession, sessionId]
  );

  React.useEffect(() => {
    // Allow to refresh all items if there is a problem with the display or something
    window.refreshItems = () => {
      setItemList(structuredClone(getItemList()));
    };
  }, [getItemList, setItemList]);

  return (
    <SessionContext.Provider
      value={{
        loadSession,
        changeGame,
        setSession,
        getSession: getCurrentSession,
        saveSession,
        sessionLoaded,
        sessionId,
        gameId: currentGameId,
        availableItems,
        boardConfig,
        messages,
        setSessionLoaded,
        isVassalSession,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
};

export const useSession = () => {
  return useContext(SessionContext);
};

export default useSession;

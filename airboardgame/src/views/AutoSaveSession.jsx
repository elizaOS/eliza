import React from "react";
import { useItems, useBoardConfig, useMessage } from "react-sync-board";
import useTimeout from "../hooks/useTimeout";
import useSession from "../hooks/useSession";

const GRACE_DELAY = import.meta.env.VITE_CI === "1" ? 100 : 3000;

export const AutoSaveSession = () => {
  const { saveSession, getSession } = useSession();
  const timeoutRef = React.useRef(null);
  const items = useItems();
  const [boardConfig] = useBoardConfig();
  const { messages } = useMessage();

  // Delay the first update to avoid too many session
  const readyRef = React.useRef(false);

  useTimeout(() => {
    readyRef.current = true;
  }, GRACE_DELAY);

  const autoSave = React.useCallback(async () => {
    const currentSession = await getSession();
    saveSession(currentSession);
  }, [getSession, saveSession]);

  React.useEffect(() => {
    if (readyRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(autoSave, GRACE_DELAY);
    }
  }, [autoSave, items, boardConfig, messages]);

  return null;
};

export default AutoSaveSession;

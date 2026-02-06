import React from "react";
import { useTranslation } from "react-i18next";

import { useUsers } from "react-sync-board";

import { FiMic, FiVideo } from "react-icons/fi";

import NavButton from "../ui/NavButton";
import useLocalStorage from "../hooks/useLocalStorage";
import { WEBCONFERENCE } from "../utils/settings";

const WebConference = React.lazy(() => import("./WebConference.jsx"));

export const WeConferenceButton = ({ room }) => {
  const { t } = useTranslation();
  const { currentUser, localUsers } = useUsers();
  const [webConference, setWebConference] = useLocalStorage(
    "enableWebconference",
    false
  );

  if (!WEBCONFERENCE) {
    return null;
  }

  const icon = WEBCONFERENCE === "video" ? FiVideo : FiMic;

  return (
    <>
      <NavButton
        onClick={() => setWebConference((prev) => !prev)}
        alt={t("Web conference")}
        title={t("Web conference")}
        Icon={icon}
        active={webConference}
      />
      {webConference && (
        <WebConference
          room={room}
          currentUser={currentUser}
          users={localUsers}
          enableVideo={WEBCONFERENCE === "video"}
        />
      )}
    </>
  );
};

export default WeConferenceButton;

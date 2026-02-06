import React from "react";

import { useTranslation } from "react-i18next";
import { useWire } from "react-sync-board";
import { FiLink } from "react-icons/fi";

import NavBar from "../../ui/NavBar";
import NavButton from "../../ui/NavButton";
import UserList from "../../users/UserList";
import WebConferenceButton from "../../webconf/WebConferenceButton";
import InviteModal from "./InviteModal";

import { useLocation } from "react-router-dom";

const RoomNavBar = () => {
  const { t } = useTranslation();
  const { room } = useWire("room");
  const { state } = useLocation();

  const [showInvite, setShowInvite] = React.useState(
    state ? state.showInvite : undefined
  );

  return (
    <>
      <NavBar position="right">
        <div className="keep-folded">
          <NavButton
            Icon={FiLink}
            onClick={() => {
              setShowInvite(true);
            }}
            title={t("Invite more player")}
          />
        </div>
        <div className="sep" />
        <div className="keep-folded">
          <UserList />
        </div>
        <div className="spacer" />
        <WebConferenceButton room={room} />
      </NavBar>
      <InviteModal show={showInvite} setShow={setShowInvite} />
    </>
  );
};

export default RoomNavBar;

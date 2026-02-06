import React from "react";

import { useTranslation } from "react-i18next";
import { useNavigate, useMatch, useParams } from "react-router-dom";
import { confirmAlert } from "react-confirm-alert";
import { useUsers } from "react-sync-board";

import {
  FiHelpCircle,
  FiUpload,
  FiSave,
  FiMove,
  FiMousePointer,
  FiHome,
  FiMaximize,
  FiRotateCw,
} from "react-icons/fi";
import { GiPokerHand } from "react-icons/gi";

import { useBoardPosition } from "react-sync-board";

import BoardForm from "./BoardForm";
import SessionForm from "./SessionForm";
import NavButton from "../../ui/NavButton";

import InfoModal from "./InfoModal";
import LoadGameModal from "./LoadGameModal";
import LoadSessionModal from "./LoadSessionModal";
import ChangeGameModal from "./ChangeGameModal";
import ExportModal from "./ExportModal";
import SaveExportModal from "./SaveExportModal";
import WelcomeModal from "./WelcomeModal";
import EditInfoButton from "./EditInfoButton";
import AddItemButton from "./AddItemButton";

import useSession from "../../hooks/useSession";

import vassalIconUrl from "../../media/images/vassal.svg?url";
import target from "../../media/images/target.svg";

import { default as RawNavBar } from "../../ui/NavBar";
import useFullScreen from "../../hooks/useFullScreen";

const LoadVassalModuleGameModal = React.lazy(() =>
  import("./LoadVassalModuleGameModal.jsx")
);

const NavBar = ({ editMode, itemLibraries, moveFirst, setMoveFirst }) => {
  const { t } = useTranslation();
  const { isVassalSession } = useSession();

  const { rotateBoard } = useBoardPosition();

  const { toggleFullScreen, active: isFullScreen } = useFullScreen();

  const { isSpaceMaster: isMaster } = useUsers();

  const navigate = useNavigate();
  const params = useParams();
  const insideARoom = useMatch("/room/:roomId/session/:sessionId");

  const [showLoadGameModal, setShowLoadGameModal] = React.useState(
    isMaster && isVassalSession
  );
  const [showSaveGameModal, setShowSaveGameModal] = React.useState(false);
  const [showChangeGameModal, setShowChangeGameModal] = React.useState(false);
  const [showInfoModal, setShowInfoModal] = React.useState(false);
  const [showLink, setShowLink] = React.useState(false);
  const [showAddPanel, setShowAddPanel] = React.useState(false);

  const handleBack = React.useCallback(() => {
    if (isFullScreen) {
      toggleFullScreen();
    }
    // If inside room, go back to that room
    if (insideARoom) {
      navigate(`/room/${params.roomId}`);
      return;
    }
    // Otherwise, go back to home
    navigate("/games");
  }, [isFullScreen, insideARoom, navigate, toggleFullScreen, params.roomId]);

  const handleBackWithConfirm = React.useCallback(() => {
    confirmAlert({
      title: t("Confirmation"),
      message: t("Do you really want to quit game edition?"),
      buttons: [
        {
          label: t("Yes"),
          onClick: async () => {
            navigate("/studio");
          },
        },
        {
          label: t("No"),
          onClick: () => {},
        },
      ],
    });
  }, [navigate, t]);

  return (
    <>
      <RawNavBar folded={true}>
        {!editMode && (
          <>
            <div className="keep-folded">
              <NavButton
                Icon={FiHome}
                onClick={handleBack}
                alt={t("Go back")}
                title={t("Go back")}
              />
            </div>
            {isMaster && (
              <>
                <div className="sep" />
                <NavButton
                  Icon={GiPokerHand}
                  onClick={() => setShowChangeGameModal((prev) => !prev)}
                  alt={t("Change game")}
                  title={t("Change game")}
                />
                <ChangeGameModal
                  show={showChangeGameModal}
                  setShow={setShowChangeGameModal}
                />
              </>
            )}
          </>
        )}
        {editMode && (
          <NavButton
            Icon={FiHome}
            onClick={handleBackWithConfirm}
            alt={t("Go back to studio")}
            title={t("Go back to studio")}
          />
        )}
        <div className="sep" />
        <AddItemButton
          itemLibraries={itemLibraries}
          setShowAddPanel={setShowAddPanel}
          showAddPanel={showAddPanel}
        />
        <div className="spacer" />
        {(isMaster || editMode) && !isVassalSession && (
          <NavButton
            onClick={() => setShowLoadGameModal((prev) => !prev)}
            alt={editMode ? t("Load game") : t("Load session")}
            title={editMode ? t("Load game") : t("Load session")}
            Icon={FiUpload}
          />
        )}
        {isMaster && isVassalSession && (
          <NavButton
            onClick={() => setShowLoadGameModal((prev) => !prev)}
            alt={t("Load Vassal module")}
            title={t("Load Vassal module")}
            icon={vassalIconUrl}
          />
        )}
        <NavButton
          onClick={() => setShowSaveGameModal((prev) => !prev)}
          alt={t("Save")}
          title={editMode ? t("Save game") : t("Save session")}
          Icon={FiSave}
        />
        <div className="spacer" />
        <div className="keep-folded">
          <NavButton
            onClick={() => setMoveFirst(!moveFirst)}
            alt={moveFirst ? t("Move mode") : t("Select mode")}
            title={
              moveFirst ? t("Switch to select mode") : t("Switch to move mode")
            }
            Icon={moveFirst ? FiMove : FiMousePointer}
          />
        </div>
        <NavButton
          Icon={FiRotateCw}
          onClick={() => rotateBoard((prev) => prev + 90)}
          alt={t("Rotate board")}
          title={t("Rotate board")}
        />
        <NavButton
          Icon={FiMaximize}
          onClick={toggleFullScreen}
          alt={t("Fullscreen")}
          title={t("Fullscreen")}
          active={isFullScreen}
        />
        <div className="sep" />
        {editMode && <EditInfoButton BoardFormComponent={BoardForm} />}
        {!editMode && isMaster && (
          <EditInfoButton BoardFormComponent={SessionForm} />
        )}
        <NavButton
          onClick={() => setShowInfoModal((prev) => !prev)}
          alt={t("Help & info")}
          title={t("Help & info")}
          Icon={FiHelpCircle}
        />
      </RawNavBar>
      {showAddPanel && (
        <img
          style={{
            position: "absolute",
            width: "60px",
            height: "60px",
            left: "calc(50% - 30px)",
            top: "calc(50% - 30px)",
            pointerEvents: "none",
            opacity: 0.3,
          }}
          src={target}
        />
      )}
      <InfoModal show={showInfoModal} setShow={setShowInfoModal} />
      {editMode && (
        <>
          <LoadGameModal
            show={showLoadGameModal}
            setShow={setShowLoadGameModal}
            edit={editMode}
          />
          <SaveExportModal
            show={showSaveGameModal}
            setShow={setShowSaveGameModal}
          />
        </>
      )}
      {!editMode && (
        <>
          <WelcomeModal show={showLink} setShow={setShowLink} welcome={false} />
          <ExportModal
            show={showSaveGameModal}
            setShow={setShowSaveGameModal}
          />
          {isVassalSession ? (
            <LoadVassalModuleGameModal
              show={showLoadGameModal}
              setShow={setShowLoadGameModal}
              edit={editMode}
            />
          ) : (
            <LoadSessionModal
              show={showLoadGameModal}
              setShow={setShowLoadGameModal}
              edit={editMode}
            />
          )}
        </>
      )}
    </>
  );
};

export default NavBar;

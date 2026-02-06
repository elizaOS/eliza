import React from "react";

import MessageButton from "../../messages/MessageButton";
import EditInfoButton from "./EditInfoButton";
import AddItemButton from "./AddItemButton";

import styled from "styled-components";
import { useTranslation } from "react-i18next";

import Touch from "../../ui/Touch";
import target from "../../media/images/target.svg";

const StyledActionBar = styled.div`
  position: absolute;
  bottom: 1em;
  right: 0em;
  display: flex;
  width: 100%;
  text-shadow: 1px 1px 2px #222;
  font-size: 0.8em;
  pointer-events: none;

  & > *:not(.spacer) {
    padding: 0 1.5em;
    pointer-events: all;
  }

  & .spacer {
    flex: 1;
  }

  @media screen and (max-width: 640px) {
    & > *:not(.spacer) {
      padding: 0 0.5em;
    }
    & .spacer {
      padding: 0;
    }
  }

  @media screen and (max-width: 420px) {
    & > *:not(.spacer) {
      padding: 0 0.2em;
    }
  }
`;

const ActionBar = ({
  editMode,
  BoardFormComponent,
  itemLibraries,
  moveFirst,
  setMoveFirst,
  hideMenu,
  setHideMenu,
}) => {
  const { t } = useTranslation();

  const [showAddPanel, setShowAddPanel] = React.useState(false);

  React.useEffect(() => {
    const onKeyUp = (e) => {
      // Block shortcut if we are typing in a textarea or input
      if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;

      if (e.key === "m") {
        setHideMenu((prev) => !prev);
        return;
      }
    };
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [setHideMenu]);

  return (
    <>
      <StyledActionBar>
        {!editMode && <MessageButton />}
        {editMode && <EditInfoButton BoardFormComponent={BoardFormComponent} />}
        <div className="spacer" />
        <Touch
          onClick={() => setMoveFirst(true)}
          alt={t("Move mode")}
          label={t("Move")}
          title={t("Switch to move mode")}
          icon={"hand"}
          active={moveFirst}
        />
        <Touch
          onClick={() => setMoveFirst(false)}
          alt={t("Select mode")}
          label={t("Select")}
          title={t("Switch to select mode")}
          icon={"mouse-pointer"}
          active={!moveFirst}
        />
        <Touch
          onClick={() => setHideMenu((prev) => !prev)}
          alt={hideMenu ? t("Show menu") : t("Hide menu")}
          label={hideMenu ? t("Show menu") : t("Hide menu")}
          title={hideMenu ? t("Show action menu") : t("Hide action menu")}
          icon={hideMenu ? "eye-with-line" : "eye"}
        />
        <div className="spacer" />
        <AddItemButton
          itemLibraries={itemLibraries}
          setShowAddPanel={setShowAddPanel}
          showAddPanel={showAddPanel}
        />
      </StyledActionBar>
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
    </>
  );
};

export default ActionBar;

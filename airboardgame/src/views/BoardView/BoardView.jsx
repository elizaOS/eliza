import React from "react";

import { Board, useUsers, useBoardConfig } from "react-sync-board";

import { SHOW_WELCOME } from "../../utils/settings";
import WelcomeModal from "./WelcomeModal";
import NavBar from "./NavBar";
import styled from "styled-components";
import SelectedItemsPane from "./SelectedItemsPane";

import { itemTemplates, backgrounds } from "../../gameComponents";

import { MediaLibraryProvider, ImageDropNPaste } from "../../mediaLibrary";
import HintOnLockedItem from "./HintOnLockedItem";
import useGlobalConf from "../../hooks/useGlobalConf";
import useSession from "../../hooks/useSession";

import flipAudio from "../../media/audio/flip.ogg?url";
import rollAudio from "../../media/audio/roll.ogg?url";
import shuffleAudio from "../../media/audio/shuffle.ogg?url";
import { preloadAudio } from "../../utils";
import UserBar from "./UserBar";

const StyledBoard = styled.div`
  & .item.locked::after {
    content: "";
    position: absolute;
    width: 24px;
    height: 30px;
    top: 4px;
    right: 4px;
    opacity: 0.1;
    user-select: none;
    overflow: hidden;
  }

  & .item.locked:hover::after {
    opacity: 0.3;
  }
`;

export const BoardView = ({
  mediaLibraries,
  edit: editMode,
  itemLibraries,
}) => {
  const { isSpaceMaster: isMaster } = useUsers();
  const { isVassalSession } = useSession();
  const [showWelcomeModal, setShowWelcomeModal] = React.useState(
    SHOW_WELCOME && !editMode && isMaster && !isVassalSession
  );

  const [boardConfig] = useBoardConfig();

  const [moveFirst, setMoveFirst] = React.useState(true);
  const [hideMenu, setHideMenu] = React.useState(false);
  const { editItem, setEditItem } = useGlobalConf();

  const style = React.useMemo(() => {
    const currentBackground =
      backgrounds.find(({ type }) => type === boardConfig.bgType) ||
      backgrounds.find(({ type }) => type === "default");
    return currentBackground.getStyle(boardConfig.bgConf);
  }, [boardConfig.bgConf, boardConfig.bgType]);

  React.useEffect(() => preloadAudio([flipAudio, shuffleAudio, rollAudio]), []);

  return (
    <MediaLibraryProvider libraries={mediaLibraries}>
      <ImageDropNPaste>
        <StyledBoard>
          <Board
            moveFirst={moveFirst}
            style={style}
            itemTemplates={itemTemplates}
            showResizeHandle={editItem}
          />
        </StyledBoard>
        <NavBar
          editMode={editMode}
          itemLibraries={itemLibraries}
          moveFirst={moveFirst}
          setMoveFirst={setMoveFirst}
          hideMenu={hideMenu}
          setHideMenu={setHideMenu}
        />
        {!editMode && <UserBar />}
        <WelcomeModal show={showWelcomeModal} setShow={setShowWelcomeModal} />
      </ImageDropNPaste>
      <SelectedItemsPane
        hideMenu={hideMenu}
        showEdit={editItem}
        setShowEdit={setEditItem}
      />
      <HintOnLockedItem />
    </MediaLibraryProvider>
  );
};

export default BoardView;

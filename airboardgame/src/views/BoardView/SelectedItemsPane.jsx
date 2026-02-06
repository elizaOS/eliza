import React from "react";
import styled from "styled-components";
import { useTranslation } from "react-i18next";

import { smallUid } from "../../utils";
import EditItemButton from "./EditItemButton";
import {
  useAvailableActions,
  useSelectedItems,
  useBoardState,
  useItemActions,
} from "react-sync-board";
import useGameItemActions from "../../gameComponents/useGameItemActions";
import FixedButton from "../../ui/FixedButton";

const ActionPaneWrapper = styled.div`
  pointer-events: none;
  position: fixed;
  bottom: 0;
  left: 40px;
  right: 40px;
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 212;
`;

const ActionPane = styled.div`
  pointer-events: all;
  user-select: none;
  touch-action: none;
  display: flex;
  background-color: var(--color-blueGrey);
  justify-content: center;
  align-items: center;
  border-top-left-radius: 4px;
  border-top-right-radius: 4px;
  padding: 0.1em 0.5em;
  height: 50px;
  overflow-x: auto;
  overflow-y: hidden;

  box-shadow: 2px 2px 10px 0.3px rgba(0, 0, 0, 0.5);
  

  & img {
    max-width: initial;
  }
  & button{
    margin 0 4px;
    padding: 0em;
    height: 50px
  }
  & .button.icon-only{
    padding: 0em;
    opacity: 0.5;
  }
  & button.icon-only:hover{
    opacity: 1;
  }
  & .count{
    color: var(--color-secondary);
    display: flex;
    flex-direction: column;
    align-items: center;
    line-height: 0.8em;
  }
  & .number{
    font-size: 1.5em;
    line-height: 1em;
  }
`;

const SelectedItemsPane = ({
  hideMenu = false,
  showEdit,
  setShowEdit,
  selecting,
  selectedItems,
  availableActions,
}) => {
  const { t } = useTranslation();
  const { findElementUnderPointer } = useItemActions();
  const { actionMap } = useGameItemActions();

  const parsedAvailableActions = React.useMemo(
    () =>
      availableActions
        .map(({ name, args }) => {
          if (!actionMap[name]) {
            console.log("Missing action " + name);
          }
          const action = { ...actionMap[name] };
          action.action = action.action(args);
          action.label = args?.customLabel || action.label(args);
          action.shortcut = args?.customShortcut || action.shortcut;
          action.uid = smallUid();
          action.args = args;
          return action;
        })
        .filter(({ multiple }) => !multiple || selectedItems.length > 1),
    [actionMap, availableActions, selectedItems]
  );

  React.useEffect(() => {
    const onKeyUp = (e) => {
      // Block shortcut if we are typing in a textarea or input
      if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;

      if (e.key === "e") {
        setShowEdit((prev) => !prev);
        return;
      }

      for (let i = 0; i < parsedAvailableActions.length; i++) {
        const { shortcut, action, edit: whileEdit } = parsedAvailableActions[i];
        if (shortcut === e.key && (showEdit || !whileEdit)) {
          action();
          break;
        }
      }
    };
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [
    actionMap,
    availableActions,
    parsedAvailableActions,
    setShowEdit,
    showEdit,
  ]);

  const onDblClick = React.useCallback(
    async (e) => {
      const foundElement = await findElementUnderPointer(e);

      // We dblclick outside of an element
      if (!foundElement) return;

      // Ignore action disabled on dblclick
      const filteredActions = parsedAvailableActions.filter(
        ({ disableDblclick }) => !disableDblclick
      );

      if (e.altKey && filteredActions.length > 1) {
        // Use second action
        filteredActions[1].action();
      } else if (filteredActions.length > 0) {
        filteredActions[0].action();
      }
    },
    [findElementUnderPointer, parsedAvailableActions]
  );

  React.useEffect(() => {
    document.addEventListener("dblclick", onDblClick);
    return () => {
      document.removeEventListener("dblclick", onDblClick);
    };
  }, [onDblClick]);

  if (hideMenu || selectedItems.length === 0) {
    return null;
  }

  return (
    <ActionPaneWrapper>
      <ActionPane>
        {(selectedItems.length > 0 || selecting) && (
          <div className="count">
            <span className="number">{selectedItems.length}</span>
            <span>{t("Items")}</span>
          </div>
        )}
        {!selecting &&
          parsedAvailableActions.map(
            ({ label, action, edit: onlyEdit, shortcut, icon: Icon, uid }) => {
              if (onlyEdit && !showEdit) return null;
              return (
                <FixedButton
                  className="button clear icon-only"
                  key={uid}
                  onClick={() => action()}
                  title={label + (shortcut ? ` (${shortcut})` : "")}
                >
                  <Icon size="24" alt={label} color="#FFFFFF" />
                </FixedButton>
              );
            }
          )}

        {!selecting && (
          <EditItemButton showEdit={showEdit} setShowEdit={setShowEdit} />
        )}
      </ActionPane>
    </ActionPaneWrapper>
  );
};

const MemoizedPanel = React.memo(SelectedItemsPane);

const SlowSelectedItemsPane = ({ setShowEdit, showEdit, hideMenu }) => {
  const [, startTransition] = React.useTransition();

  const { availableActions } = useAvailableActions();
  const selectedItems = useSelectedItems();
  const boardState = useBoardState();

  const [slowAvailableActions, setSlowAvailableActions] = React.useState([]);
  const [slowSelectedItems, setSlowSelectedItems] = React.useState([]);

  React.useEffect(() => {
    if (boardState.movingItems || boardState.zooming || boardState.panning) {
      setShowEdit(false);
    }
  }, [
    boardState.movingItems,
    boardState.panning,
    boardState.zooming,
    setShowEdit,
  ]);

  React.useEffect(() => {
    startTransition(() => {
      setSlowAvailableActions(availableActions);
    });
  }, [availableActions]);

  React.useEffect(() => {
    startTransition(() => {
      setSlowSelectedItems(selectedItems);
    });
  }, [selectedItems]);

  return (
    <MemoizedPanel
      hideMenu={hideMenu}
      showEdit={showEdit}
      setShowEdit={setShowEdit}
      selecting={boardState.selecting}
      selectedItems={slowSelectedItems}
      availableActions={slowAvailableActions}
    />
  );
};

export default SlowSelectedItemsPane;

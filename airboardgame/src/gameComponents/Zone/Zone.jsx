import React from "react";
import { memo } from "react";
import styled, { css } from "styled-components";
import { useItemInteraction, useItemActions } from "react-sync-board";
import { opacify } from "color2k";

import { getHeldItems, areItemsInside } from "../../utils/item";
import useGameItemActions from "../useGameItemActions";

const ZoneWrapper = styled.div`
  ${({ width, height, borderColor, borderStyle, backgroundColor }) => css`
    width: ${width}px;
    height: ${height}px;
    border: 0.5em ${borderStyle} ${borderColor};
    background-color: ${backgroundColor};
    border-radius: 5px;
    position: relative;
    & .zone__label {
      font-size: 1.5em;
      user-select: none;
      background-color: ${opacify(borderColor, 1)};
      position: absolute;
      border-radius: 0.5em;
      color: var(--color-darkGrey);
    }

    & .zone__label.left {
      padding: 1em 0em;
      top: 1em;
      left: -1em;
      letter-spacing: -3px;
      writing-mode: vertical-rl;
      text-orientation: upright;
    }

    & .zone__label.top {
      padding: 0em 1em;
      top: -1em;
      left: 1em;
    }
  `}
`;

const Zone = ({
  width = 200,
  height = 200,
  borderColor = "#cccccc33",
  borderStyle = "dotted",
  backgroundColor = "transparent",
  labelPosition = "left",
  label,
  holdItems = false,
  setState,
  onItem,
  id: currentItemId,
}) => {
  const { register } = useItemInteraction("place");
  const { register: registerDelete } = useItemInteraction("delete");
  const { getItemList } = useItemActions();
  const { actionMap } = useGameItemActions();

  const zoneRef = React.useRef(null);

  const onInsideItem = React.useCallback(
    (itemIds) => {
      setState((item) => {
        const newLinkedItems = getHeldItems({
          element: zoneRef.current,
          currentItemId,
          currentLinkedItemIds: item.linkedItems,
          itemList: getItemList(),
          itemIds,
          shouldHoldItems: item.holdItems,
        });

        if (item.linkedItems !== newLinkedItems) {
          return {
            linkedItems: newLinkedItems,
          };
        }
      }, true);

      setState((item) => {
        const safeInsideItems = Array.isArray(item.insideItems)
          ? item.insideItems
          : [];
        const insideMap = areItemsInside(
          zoneRef.current,
          itemIds,
          safeInsideItems
        );
        const addedItems = Object.entries(insideMap)
          .filter(([, { added }]) => added)
          .map(([itemId]) => itemId);

        const currentInsideItems = Object.entries(insideMap)
          .filter(([, { inside }]) => inside)
          .map(([itemId]) => itemId);

        if (onItem && addedItems.length) {
          const onItemActions = onItem.map((action) => {
            if (typeof action === "string") {
              return { name: action };
            }
            return action;
          });
          onItemActions.forEach(({ name, args }) => {
            if (actionMap[name]) {
              actionMap[name].action(args)(addedItems);
            }
          });
        }
        const oldLinked = new Set(safeInsideItems);
        const newLinked = new Set(currentInsideItems);

        if (
          newLinked.size !== oldLinked.size ||
          !Array.from(oldLinked).every((id) => newLinked.has(id))
        ) {
          return { insideItems: currentInsideItems };
        }
      }, true);
    },
    [actionMap, currentItemId, getItemList, onItem, setState]
  );

  const onDeleteItem = React.useCallback(
    (itemIds) => {
      setState((item) => {
        const safeInsideItems = item.insideItems || [];
        const newInsideItems = safeInsideItems.filter(
          (id) => !itemIds.includes(id)
        );

        if (safeInsideItems.length !== newInsideItems.length) {
          return {
            insideItems: newInsideItems,
          };
        }
      }, true);
    },
    [setState]
  );

  React.useEffect(() => {
    if (!holdItems && setState) {
      setState((item) => {
        if (!Array.isArray(item.linkedItems) || item.linkedItems.length > 0) {
          return { linkedItems: [] };
        }
      }, true);
    }
  }, [holdItems, setState]);

  React.useEffect(() => {
    const unregisterList = [];
    if (currentItemId) {
      unregisterList.push(register(onInsideItem));
    }

    return () => {
      unregisterList.forEach((callback) => callback());
    };
  }, [currentItemId, onInsideItem, onItem, register]);

  React.useEffect(() => {
    const unregisterList = [];
    if (currentItemId) {
      unregisterList.push(registerDelete(onDeleteItem));
    }

    return () => {
      unregisterList.forEach((callback) => callback());
    };
  }, [currentItemId, onDeleteItem, registerDelete]);

  return (
    <ZoneWrapper
      width={width}
      height={height}
      ref={zoneRef}
      borderStyle={borderStyle}
      borderColor={borderColor}
      backgroundColor={backgroundColor}
    >
      <div className={`zone__label ${labelPosition}`}>{label}</div>
    </ZoneWrapper>
  );
};

export default memo(Zone);

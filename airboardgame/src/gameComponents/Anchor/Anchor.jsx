import React from "react";
import { memo } from "react";
import styled, { css } from "styled-components";
import { transparentize } from "color2k";
import {
  useBoardState,
  useItemActions,
  useItemInteraction,
  useSelectedItems,
} from "react-sync-board";
import useAsyncEffect from "use-async-effect";

import { getItemElement, fastItemIntersect } from "../../utils";
import useGameItemActions from "../useGameItemActions";
import useGlobalConf from "../../hooks/useGlobalConf";

const StyledAnchor = styled.div`
  ${({ highlight, editMode, color }) => css`
    width: 30px;
    height: 30px;
    border: 3px solid ${color};
    background-color: ${transparentize(color, 0.4)};
    border-radius: 100%;
    position: relative;
    transition: opacity 300ms;
    opacity: ${highlight ? "1" : editMode ? "0.8" : "0.05"};

    .item-library__component & {
      opacity: 1;
    }

    .selected & {
      opacity: 1;
    }
  `}
`;

const Anchor = ({ families, id, color = "#CCC" }) => {
  const { register } = useItemInteraction("place");
  const { snapToPoint } = useGameItemActions();
  const { getItems } = useItemActions();
  const { movingItems } = useBoardState();
  const { editMode, editItem } = useGlobalConf();
  const selectedItems = useSelectedItems();
  const [shouldHighlight, setShouldHighlight] = React.useState(false);

  const noFamilies = !Array.isArray(families) || families.length === 0;

  const onInsideItem = React.useCallback(
    async (itemIds) => {
      const currentItem = getItemElement(id);

      const items = await getItems(itemIds);

      const insideItems = items
        .filter((item) => noFamilies || families.includes(item.groupId))
        .filter(
          ({ id: itemId }) =>
            itemId !== id &&
            fastItemIntersect(getItemElement(itemId), currentItem)
        )
        .map(({ id }) => id);

      if (!insideItems.length) return;

      const [thisItem] = await getItems([id]);

      snapToPoint(insideItems, { x: thisItem.x + 15, y: thisItem.y + 15 });
    },
    [id, getItems, snapToPoint, noFamilies, families]
  );

  React.useEffect(() => {
    const unregister = [];
    // If no Id then we are in the library
    if (id) {
      unregister.push(register(onInsideItem));
    }
    return () => {
      unregister.forEach((unregisterMe) => unregisterMe());
    };
  }, [onInsideItem, register, id]);

  useAsyncEffect(
    async (isMounted) => {
      /**
       * Highlight only if the set of family of the selected items is included in the
       * set of item of the anchor.
       */
      if (noFamilies || selectedItems.length === 0) {
        // Always highlight if this anchor is not specific
        setShouldHighlight(true);
        return;
      }
      const selectedItemsList = await getItems(selectedItems);
      if (!isMounted) {
        return;
      }
      // Construct the family set
      const familySet = new Set(
        selectedItemsList.map((item) => item.groupId || "__NO_FAMILY__")
      );
      if (Array.from(familySet).every((family) => families.includes(family))) {
        setShouldHighlight(true);
      } else {
        setShouldHighlight(false);
      }
    },
    [noFamilies, selectedItems]
  );

  return (
    <StyledAnchor
      highlight={movingItems && shouldHighlight}
      editMode={editMode || editItem}
      color={color}
    />
  );
};

export default memo(Anchor);

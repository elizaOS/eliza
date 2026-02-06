import React, { memo } from "react";
import styled, { css } from "styled-components";
import { useItemActions, useItemInteraction, useUsers } from "react-sync-board";
import { FiMove } from "react-icons/fi";
import { useTranslation } from "react-i18next";
import debounce from "lodash.debounce";

import { uid, getItemElement } from "../../utils";
import { isItemCenterInsideElement } from "../../utils/item";
import itemTemplates from "../itemTemplates";

const StyledShape = styled.div`
  ${({ color }) => css`
    box-shadow: rgba(60, 64, 67, 0.3) 0px 1px 2px 0px,
      rgba(60, 64, 67, 0.15) 0px 1px 3px 1px;
    border: 3px dashed black;
    border-color: ${color};

    border-radius: 3px;
    background-color: #cccccc22;

    & .wrapper {
      opacity: 0.3;
      position: relative;
    }

    & .item-wrapper {
      position: absolute;
      top: ${({ center: { top } }) => `${top}px`};
      left: ${({ center: { left } }) => `${left}px`};
    }

    & .handle {
      position: absolute;
      top: -15px;
      left: -15px;
      user-select: none;
      & img {
        pointer-events: none;
      }
    }

    & .generator__empty-message {
      display: block;
      width: 60px;
      height: 60px;
      font-size: 0.65em;
      text-align: center;

      .item-library__component & {
        visibility: hidden;
      }
    }
  `}
`;

const Generator = ({ color = "#ccc", item, id, currentItemId, setState }) => {
  const { t } = useTranslation();
  const { isSpaceMaster: isMaster } = useUsers();
  const itemRef = React.useRef(null);
  const [dimension, setDimension] = React.useState({
    width: 50,
    height: 50,
  });
  const [center, setCenter] = React.useState({ top: 0, left: 0 });
  const { register: registerPlace } = useItemInteraction("place");
  const { register: registerDelete } = useItemInteraction("delete");
  const {
    pushItem,
    getItems,
    batchUpdateItems,
    removeItems,
  } = useItemActions();

  const centerRef = React.useRef(center);
  Object.assign(centerRef.current, center);
  const currentItemRef = React.useRef(currentItemId);
  currentItemRef.current = currentItemId;

  const addItem = React.useCallback(async () => {
    /**
     * Add new generated item
     */
    const newItemId = uid();
    currentItemRef.current = newItemId;
    const [thisItem] = getItems([id]);
    const { item } = thisItem || {}; // Inside item library, thisItem is not defined
    if (item?.type) {
      setState((prev) => ({
        ...prev,
        currentItemId: newItemId,
        linkedItems: [newItemId],
      }));
      await pushItem({
        ...item,
        x: thisItem.x + centerRef.current.left + 3,
        y: thisItem.y + centerRef.current.top + 3,
        layer: thisItem.layer + 1,
        editable: false,
        id: newItemId,
      });
    }
  }, [getItems, id, pushItem, setState]);

  /**
   * Set generator dimension according to Item content.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resize = React.useCallback(
    debounce((rotation) => {
      let targetWidth, targetHeight;

      if (!itemRef.current) {
        // The component is probably unmounted
        return;
      }

      const { clientWidth, clientHeight } = itemRef.current;
      targetWidth = clientWidth;
      targetHeight = clientHeight;

      if (currentItemRef.current) {
        // Get size from current item if any
        const currentDomItem = getItemElement(currentItemRef.current);
        if (currentDomItem) {
          targetWidth = currentDomItem.clientWidth;
          targetHeight = currentDomItem.clientHeight;
        }
      }

      /* Compute size relative to rotation */
      const rad = (rotation || 0) * (Math.PI / 180);

      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));

      const width = targetWidth * cos + targetHeight * sin;
      const height = targetWidth * sin + targetHeight * cos;

      const top = -targetHeight / 2 + height / 2 + 3;
      const left = -targetWidth / 2 + width / 2 + 3;

      setCenter({
        top,
        left,
      });
      centerRef.current = {
        top,
        left,
      };

      setDimension((prev) => ({ ...prev, width, height }));
    }, 100),
    []
  );

  const onPlaceItem = React.useCallback(
    async (itemIds) => {
      /**
       * Callback if generated item or generator is placed
       */
      const placeSelf = itemIds.includes(id);

      const [thisItem] = await getItems([id]);

      if (
        itemIds.includes(currentItemRef.current) &&
        !placeSelf &&
        !isItemCenterInsideElement(
          getItemElement(currentItemRef.current),
          itemRef.current
        )
      ) {
        // We have removed generated item so we create a new one.
        batchUpdateItems([currentItemRef.current], (item) => {
          const result = {
            ...item,
            layer: thisItem.layer,
          };
          delete result.editable;
          return result;
        });

        await addItem();
        resize(item?.rotation);
      }
      if (placeSelf) {
        if (!currentItemRef.current) {
          // Missing item for any reason
          await addItem();
        }
        resize(item?.rotation);
      }
    },
    [addItem, batchUpdateItems, getItems, id, item?.rotation, resize]
  );

  const onDeleteItem = React.useCallback(
    async (itemIds) => {
      /**
       * Callback if an item is deleted
       */
      if (itemIds.includes(currentItemRef.current)) {
        await addItem();
      }
    },
    [addItem]
  );

  React.useEffect(() => {
    /**
     * update item on modifications only if master
     */
    if (item?.type && isMaster) {
      batchUpdateItems([currentItemRef.current], (prev) => ({
        ...prev,
        ...item,
      }));
    }
  }, [batchUpdateItems, isMaster, item]);

  React.useEffect(() => {
    /**
     * Add item if missing
     */
    if (isMaster && !currentItemId && !currentItemRef.current && item?.type) {
      addItem();
    }
  }, [addItem, currentItemId, isMaster, item?.type]);

  React.useEffect(() => {
    /**
     * Check if type is defined
     */
    const checkType = async () => {
      if (currentItemRef.current) {
        const [currentItem] = await getItems([currentItemRef.current]);
        if (currentItem?.type !== item.type) {
          if (currentItem) {
            // Remove old if exists
            await removeItems([currentItemRef.current]);
          }
          // Add new item on new type
          await addItem();
        }
      }
    };

    if (item?.type && isMaster) {
      checkType();
    }
  }, [addItem, getItems, item?.type, removeItems, isMaster]);

  React.useEffect(() => {
    /**
     * Register events callback
     */
    const unregisterList = [];
    if (currentItemId) {
      unregisterList.push(registerPlace(onPlaceItem));
      unregisterList.push(registerDelete(onDeleteItem));
    }

    return () => {
      unregisterList.forEach((callback) => callback());
    };
  }, [registerPlace, registerDelete, onPlaceItem, onDeleteItem, currentItemId]);

  React.useEffect(() => {
    /**
     * Update center and generator width height
     */
    resize(item?.rotation);
  }, [item, resize, dimension.height, dimension.width]);

  // Define item component if type is defined
  let Item = () => (
    <div className="generator__empty-message">{t("No item type defined")}</div>
  );
  if (item) {
    const itemTemplate = itemTemplates[item.type];
    Item = itemTemplate.component;
  }

  return (
    <StyledShape color={color} center={center}>
      <div className="handle">
        <FiMove size="20" color="white" />
      </div>
      <div className="wrapper" style={dimension}>
        <div
          style={{
            transform: `rotate(${item?.rotation || 0}deg)`,
          }}
          ref={itemRef}
          className="item-wrapper"
        >
          <Item {...item} />
        </div>
      </div>
    </StyledShape>
  );
};

export default memo(Generator);

import React, { memo, useState } from "react";
import { useUsers } from "react-sync-board";
import styled from "styled-components";
import { media2Url } from "../../mediaLibrary";
import { FiEye } from "react-icons/fi";
import { useItemInteraction, useItemActions } from "react-sync-board";

import { getHeldItems } from "../../utils/item";
import Canvas from "../Canvas";
import { getImage } from "../../utils/image";

const UnflippedFor = styled.div`
  position: absolute;
  top: 2px;
  right: 2px;
  color: #555;
  font-size: 0.6em;
  display: flex;
  justify-content: center;
  align-items: center;

  pointer-events: none;
  line-height: 0;
  opacity: 0.6;
`;

const UnflippedForUser = styled.div`
  background-color: ${({ color }) => color};
  color: white;
  border-radius: 3px;
  padding: 4px;
  margin: 4px;
`;

const Wrapper = styled.div`
  user-select: none;
  position: relative;
  line-height: 0em;
`;

const Label = styled.div`
  position: absolute;
  top: 1px;
  right: 1px;
  padding: 0 3px;
  background-color: black;
  color: white;
  border-radius: 0.5em;
  opacity: 0.5;
  font-size: 0.6em;
  line-height: 1.5em;
`;

/*

const layer={
  name: 'ttt',
  images: {...}
  side: "front"|"back"|"both"
  offsetX: 0,
  offsetY:0,
  uid: ''
}

*/

const AdvancedImage = ({
  width,
  height,
  front,
  back,
  flipped = false,
  unflippedFor,
  setState,
  text,
  backText,
  layers,
  id: currentItemId,
}) => {
  const { register } = useItemInteraction("place");
  const { getItemList } = useItemActions();
  const wrapperRef = React.useRef(null);
  const { currentUser, localUsers: users } = useUsers();

  const frontUrl = media2Url(front);
  const backUrl = media2Url(back);

  const unflippedForUsers = React.useMemo(() => {
    if (Array.isArray(unflippedFor)) {
      return unflippedFor
        .filter((userId) => users.find(({ uid }) => userId === uid))
        .map((userId) => users.find(({ uid }) => userId === uid));
    }
    return null;
  }, [unflippedFor, users]);

  const flippedForMe =
    backUrl &&
    flipped &&
    (!Array.isArray(unflippedFor) || !unflippedFor.includes(currentUser.uid));

  const canvasLayers = React.useMemo(() => {
    const result = [];
    if (flippedForMe) {
      result.push({ url: backUrl });
    } else {
      result.push({ url: frontUrl });
    }
    layers?.forEach(({ value = 0, images, side, offsetX = 0, offsetY = 0 }) => {
      if (
        side === "both" ||
        (side === "front" && !flippedForMe) ||
        (side === "back" && flippedForMe)
      ) {
        const currentImage = images[value];
        const url = media2Url(currentImage);
        result.push({ url, offsetX, offsetY });
      }
    });
    return result;
  }, [backUrl, flippedForMe, frontUrl, layers]);

  React.useEffect(() => {
    // preload images
    getImage(frontUrl);
    if (backUrl) {
      getImage(backUrl);
    }
  }, [frontUrl, backUrl]);

  const onPlaceItem = React.useCallback(
    (itemIds) => {
      setState((item) => {
        const newLinkedItems = getHeldItems({
          element: wrapperRef.current,
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
    },
    [currentItemId, getItemList, setState]
  );

  React.useEffect(() => {
    const unregisterList = [];
    if (currentItemId) {
      unregisterList.push(register(onPlaceItem));
    }

    return () => {
      unregisterList.forEach((callback) => callback());
    };
  }, [currentItemId, onPlaceItem, register]);

  return (
    <Wrapper ref={wrapperRef}>
      <Canvas
        layers={canvasLayers}
        width={width}
        height={height}
        useCanvas={true}
      />
      {flippedForMe && backText && <Label>{backText}</Label>}
      {(!flippedForMe || !backText) && text && <Label>{text}</Label>}
      <UnflippedFor>
        {unflippedForUsers &&
          unflippedForUsers.map(({ color, id }) => {
            return (
              <UnflippedForUser key={id} color={color}>
                <FiEye color="white" size="16" />
              </UnflippedForUser>
            );
          })}
      </UnflippedFor>
    </Wrapper>
  );
};

export default memo(AdvancedImage);

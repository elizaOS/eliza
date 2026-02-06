import React, { memo } from "react";
import { useItemInteraction } from "react-sync-board";
import { media2Url } from "../../mediaLibrary";
import useGameItemActions from "../useGameItemActions";
import Canvas from "../Canvas";

const Dice = ({
  id,
  value = 0,
  images,
  width = 50,
  height = 50,
  rollOnDblClick = false,
  rollOnMove = !rollOnDblClick,
}) => {
  const { register } = useItemInteraction("place");
  const { roll } = useGameItemActions();

  React.useEffect(() => {
    const unregisterList = [];
    if (id && rollOnMove) {
      const rollOnPlace = (itemIds) => {
        if (itemIds.includes(id)) {
          roll([id]);
        }
      };
      unregisterList.push(register(rollOnPlace));
    }
    return () => {
      unregisterList.forEach((callback) => callback());
    };
  }, [roll, register, id, rollOnMove]);

  let url = "/default.png";
  if (images[value]) {
    url = media2Url(images[value]);
  }

  return <Canvas layers={[{ url }]} height={height} width={width} />;
};

export default memo(Dice);

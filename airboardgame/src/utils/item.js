import {
  rectRadius,
  isPointInsideRect,
  isPointInPolygon,
  distance,
} from "./geometry";

export const isItemInsideElement = (itemElement, otherElem) => {
  const rect = otherElem.getBoundingClientRect();
  const fourElem = Array.from(itemElement.querySelectorAll(".corner"));
  return fourElem.every((corner) => {
    const { top: y, left: x } = corner.getBoundingClientRect();
    return isPointInsideRect({ x, y }, rect);
  });
};

export const isItemCenterInsideElement = (itemElement, otherElem) => {
  const rect = otherElem.getBoundingClientRect();
  const itemCenter = getItemCenter(itemElement);
  return isPointInsideRect(itemCenter, rect);
};

export const areItemsInside = (
  element,
  itemIds,
  previousIds = [],
  centerOnly = false
) => {
  return Object.fromEntries(
    [...itemIds, ...previousIds].map((itemId) => {
      const elementToTest = getItemElement(itemId);
      if (!elementToTest) {
        return [itemId, { inside: false, added: false, removed: true }];
      }
      const inside = centerOnly
        ? isItemCenterInsideElement(elementToTest, element)
        : isItemInsideElement(elementToTest, element);

      return [
        itemId,
        {
          inside,
          added: inside && !previousIds.includes(itemId),
          removed: !inside && previousIds.includes(itemId),
        },
      ];
    })
  );
};

export const pointInItem = (itemElement, point) => {
  return isPointInPolygon(point, getItemPolygon(itemElement));
};

export const getItemPolygon = (itemElement, asArray = false) => {
  const fourElem = Array.from(itemElement.querySelectorAll(".corner"));
  if (asArray) {
    return fourElem.map((corner) => {
      const { top: y, left: x } = corner.getBoundingClientRect();
      return [x, y];
    });
  }
  return fourElem.map((corner) => {
    const { top: y, left: x } = corner.getBoundingClientRect();
    return { x, y };
  });
};

export const getItemCenter = (itemElement) => {
  const center = Array.from(itemElement.querySelectorAll(".center"))[0];
  const { top: y, left: x } = center.getBoundingClientRect();
  return { x, y };
};

export const fastItemIntersect = (item1, item2) => {
  const p1 = getItemPolygon(item1);
  const c1 = getItemCenter(item1);
  const p2 = getItemPolygon(item2);
  const c2 = getItemCenter(item2);

  const r1 = rectRadius(p1, c1);
  const r2 = rectRadius(p2, c2);
  const dist = distance(c1, c2);

  return dist <= r1 + r2;
};

export const getItemElement = (id) => {
  const elem = document.getElementsByClassName(`item ${id}`)[0];
  if (!elem) {
    console.warn(`Missing element for id ${id}`);
  }
  return elem;
};

export const availableItemVisitor = async (items, callback) => {
  return await Promise.all(
    items.map(async (node) => {
      if (node.items) {
        return {
          ...node,
          items: await availableItemVisitor(node.items, callback),
        };
      } else {
        // It's an element
        return await callback(node);
      }
    })
  );
};

export const getHeldItems = ({
  element,
  currentItemId,
  currentLinkedItemIds,
  itemList,
  itemIds,
  shouldHoldItems,
}) => {
  const safeCurrentLinkedItems = Array.isArray(currentLinkedItemIds)
    ? currentLinkedItemIds
    : [];

  if (shouldHoldItems) {
    const currentItemIndex = itemList.findIndex(
      ({ id }) => id === currentItemId
    );
    const currentItemLayer = itemList[currentItemIndex].layer || 0;

    const afterMap = Object.fromEntries(
      itemList.map(({ id, layer = 0 }, index) => {
        return [
          id,
          layer > currentItemLayer ||
            (layer === currentItemLayer && index > currentItemIndex),
        ];
      })
    );
    const afterItemIds = itemIds.filter((id) => afterMap[id]);

    const afterCurrentLinkedItemIds = (currentLinkedItemIds || []).filter(
      (id) => afterMap[id]
    );

    const newHeldItems = Object.entries(
      areItemsInside(element, afterItemIds, afterCurrentLinkedItemIds, true)
    )
      .filter(([, { inside }]) => inside)
      .map(([itemId]) => itemId);

    const oldLinked = new Set(safeCurrentLinkedItems);
    const newLinked = new Set(newHeldItems);

    if (
      newLinked.size !== oldLinked.size ||
      !Array.from(oldLinked).every((id) => newLinked.has(id))
    ) {
      return newHeldItems;
    }
  } else {
    if (safeCurrentLinkedItems.length !== 0) {
      return safeCurrentLinkedItems;
    }
  }

  return currentLinkedItemIds;
};

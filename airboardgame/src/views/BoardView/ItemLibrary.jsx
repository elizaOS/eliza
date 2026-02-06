import React, { memo } from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import debounce from "lodash.debounce";

import { useItemActions } from "react-sync-board";

import { search, uid } from "../../utils";

import Chevron from "../../ui/Chevron";

const StyledItemList = styled.ul`
  display: flex;
  flex-flow: row wrap;
  list-style: none;
  margin: 0;
  padding: 0;
  & li.group {
    background-color: rgba(0, 0, 0, 0.1);
    padding: 0 0.5em;
    flex-basis: 100%;
  }
  overflow: visible;
`;

const StyledItem = styled.li`
  display: block;
  padding: 0.5em;
  margin: 0.2em;
  cursor: pointer;
  opacity: 0.7;

  &:hover {
    opacity: 1;
  }
  & > div {
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: none;
    max-width: 80px;
    & > span {
      margin-top: 0.2em;
      text-align: center;
      max-width: 80px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 0.2em 0.5em;
    }
  }
  &:hover > div > span {
    z-index: 2;
    max-width: none;
    overflow: visible;
    background-color: #222;
    box-shadow: 0px 3px 6px #00000029;
  }
`;

const size = 60;

const NewItem = memo(({ type, template, component: Component, name }) => {
  const { pushItem } = useItemActions();

  const addItem = React.useCallback(async () => {
    pushItem({
      ...(typeof template === "function" ? template() : template),
      id: uid(),
      type,
    });
  }, [pushItem, template, type]);

  return (
    <StyledItem onClick={addItem}>
      <div className="item-library__component">
        <Component
          {...(typeof template === "function" ? template() : template)}
          width={size}
          height={size}
          size={size}
        />
        <span>{name}</span>
      </div>
    </StyledItem>
  );
});

NewItem.displayName = "NewItem";

const SubItemList = ({ name, items }) => {
  const { t } = useTranslation();
  const isDefaultOpen =
    items.filter(({ items }) => !Array.isArray(items)).length === 0;
  const [open, setOpen] = React.useState(isDefaultOpen);
  const { pushItems } = useItemActions();

  const addItems = React.useCallback(
    async (itemsToAdd) => {
      pushItems(
        itemsToAdd.map(({ template }) => ({
          ...(typeof template === "function" ? template() : template),
          id: uid(),
        }))
      );
    },
    [pushItems]
  );

  return (
    <>
      <h3
        onClick={() => setOpen((prev) => !prev)}
        style={{ cursor: "pointer" }}
      >
        {open ? (
          <Chevron orientation="bottom" color="#8c8c8c" />
        ) : (
          <Chevron color="#8c8c8c" />
        )}{" "}
        {name}{" "}
        <span
          style={{ fontSize: "0.6em" }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            addItems(items);
          }}
        >
          [{t("Add all")}]
        </span>
      </h3>
      {open && <ItemList items={items} />}
    </>
  );
};

const ItemList = ({ items }) => (
  <StyledItemList>
    {items.map((node) => {
      if (node.type) {
        return <NewItem {...node} key={node.uid} />;
      }
      // it's a group
      return (
        <li key={`group_${node.name}`} className="group">
          <SubItemList {...node} />
        </li>
      );
    })}
  </StyledItemList>
);

const MemoizedItemList = memo(ItemList);

const filterItems = (filter, nodes) =>
  nodes.reduce((acc, node) => {
    if (node.type) {
      if (search(filter, node.name)) {
        acc.push(node);
      }
      return acc;
    }
    const filteredItems = filterItems(filter, node.items);
    if (filteredItems.length) {
      acc.push({ ...node, items: filteredItems });
    }
    return acc;
  }, []);

/**
 * In the Item library we have a hierarchical structure where nodes are
 *
 * {
 *   name, // Name of the group
 *   items: [...] // Items/subgroup in this group
 * }
 *
 * and items (leaf) are
 *
 * {
 *   type, // It's an element
 *   ... // Other element properties
 * }
 *
 */

const ItemLibrary = ({ items }) => {
  const { t } = useTranslation();
  const [filter, setFilter] = React.useState("");
  const [filteredItems, setFilteredItems] = React.useState(items);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedFilterItems = React.useCallback(
    debounce((filterToApply, itemsToFilter) => {
      setFilteredItems(filterItems(filterToApply, itemsToFilter));
    }, 500),
    []
  );

  React.useEffect(() => {
    debouncedFilterItems(filter, items);
  }, [debouncedFilterItems, filter, items]);

  return (
    <>
      <input
        onChange={(e) => setFilter(e.target.value)}
        style={{ marginBottom: "1em" }}
        placeholder={t("Search...")}
      />
      <MemoizedItemList items={filteredItems} />
    </>
  );
};

export default memo(ItemLibrary);

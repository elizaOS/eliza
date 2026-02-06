import React from "react";
import { useTranslation } from "react-i18next";
import { Field } from "react-final-form";

import Label from "../ui/formUtils/Label";
import Hint from "../ui/formUtils/Hint";
import Slider from "../ui/Slider";

import ActionList from "./ActionList";

import { itemTemplates } from "./";

import { objectIntersection } from "../utils";

export const getFormFieldComponent = (type) => {
  if (type in itemTemplates) {
    return itemTemplates[type].form;
  }
  return () => null;
};

const getDefaultActionsFromItem = (item) => {
  if (item.type in itemTemplates) {
    const actions = itemTemplates[item.type].defaultActions;
    if (typeof actions === "function") {
      return actions(item);
    }
    return actions;
  }

  return [];
};

const getAvailableActionsFromItem = (item) => {
  if (item.type in itemTemplates) {
    const actions = itemTemplates[item.type].availableActions;
    if (typeof actions === "function") {
      return actions(item);
    }
    return actions;
  }

  return [];
};

const getExcludedFields = (types) => {
  return types.reduce((excluded, type) => {
    return Object.assign(excluded, itemTemplates[type].excludeFields || {});
  }, {});
};

const toInt = (val) => {
  const value = parseInt(val, 10);
  if (isNaN(value)) {
    return 0;
  }
  return value;
};

const ItemForm = ({ items, types, extraExcludeFields }) => {
  const { t } = useTranslation();

  const oneType = types.length === 1;

  const FieldsComponent = React.useMemo(() => {
    if (oneType) {
      return getFormFieldComponent(types[0]);
    } else {
      return () => null;
    }
  }, [oneType, types]);

  const availableActions = React.useMemo(() => {
    if (oneType) {
      return getAvailableActionsFromItem(items[0]);
    }
    return [];
  }, [items, oneType]);

  // Merge extra excluded fields and all item excluded fields
  const excludeFields = React.useMemo(() => {
    return { ...getExcludedFields(types), ...extraExcludeFields };
  }, [extraExcludeFields, types]);

  const initialValues = React.useMemo(() => {
    const [firstItem, ...restItems] = items.map((item) => {
      const newActions = (item.actions || getDefaultActionsFromItem(item)).map(
        (action) => {
          if (typeof action === "string") {
            return { name: action };
          }
          return action;
        }
      );
      return {
        ...item,
        actions: newActions,
      };
    });

    // Set initial values to intersection of all common item values
    return restItems.reduce(
      objectIntersection,
      JSON.parse(JSON.stringify(firstItem))
    );
  }, [items]);

  const {
    locked = false,
    rotation = 0,
    layer = 0,
    groupId = "",
    grid: {
      type: gridType = "",
      size: gridSize = 1,
      offset: { x: gridOffsetX = 0, gridOffsetY = 0 } = {},
    } = {},
    actions = [],
  } = initialValues;

  return (
    <>
      {!excludeFields.locked && (
        <Label>
          <Field
            name="locked"
            component="input"
            type="checkbox"
            initialValue={locked}
          />
          <span className="checkable">{t("Locked?")}</span>
          <Hint>{t("Lock action help")}</Hint>
        </Label>
      )}
      {!excludeFields.rotation && (
        <Label>
          {t("Rotation")}
          <Field name="rotation" initialValue={rotation}>
            {({ input: { onChange, value } }) => {
              return (
                <Slider
                  defaultValue={0}
                  value={value}
                  min={-180}
                  max={180}
                  step={5}
                  included={false}
                  marks={{
                    "-180": -180,
                    "-90": -90,
                    "-45": -45,
                    "-30": -30,
                    0: 0,
                    30: 30,
                    45: 45,
                    90: 90,
                    180: 180,
                  }}
                  onChange={onChange}
                  className={"slider-rotation"}
                />
              );
            }}
          </Field>
        </Label>
      )}
      {!excludeFields.layer && (
        <Label>
          {t("Layer")}
          <Field name="layer" initialValue={layer}>
            {({ input: { onChange, value } }) => {
              return (
                <Slider
                  defaultValue={0}
                  value={value}
                  min={-3}
                  max={3}
                  step={1}
                  included={false}
                  marks={{
                    "-3": -3,
                    "-2": -2,
                    "-1": -1,
                    0: 0,
                    "1": 1,
                    "2": 2,
                    "3": 3,
                  }}
                  onChange={onChange}
                  className={"slider-layer"}
                />
              );
            }}
          </Field>
        </Label>
      )}
      {!excludeFields.family && (
        <Label>
          {t("Family")}
          <Field name="groupId" component="input" initialValue={groupId} />
          <Hint>
            {t(
              "Optional - Use the same family name for items that are part of the same set."
            )}
          </Hint>
        </Label>
      )}
      <FieldsComponent initialValues={initialValues} />
      {!excludeFields.grid && (
        <>
          <h3>{t("Snap to grid")}</h3>
          <Label>
            {t("Grid type")}
            <Field name="grid.type" initialValue={gridType} component="select">
              <option value="none">{t("None")}</option>
              <option value="grid">{t("Grid")}</option>
              <option value="hexH">{t("Horizontal hexagons")}</option>
              <option value="hexV">{t("Vertical hexagons")}</option>
            </Field>
          </Label>
          <div style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
            <Label>
              {t("Size")}
              <Field name="grid.size" component="input" initialValue={gridSize}>
                {(props) => <input {...props.input} type="number" />}
              </Field>
            </Label>
            <Label>
              {t("Horizontal offset")}
              <Field
                name="grid.offset.x"
                component="input"
                parse={toInt}
                initialValue={gridOffsetX}
              >
                {(props) => <input {...props.input} type="number" />}
              </Field>
            </Label>
            <Label>
              {t("Vertical offset")}
              <Field
                name="grid.offset.y"
                component="input"
                parse={toInt}
                initialValue={gridOffsetY}
              >
                {(props) => <input {...props.input} type="number" />}
              </Field>
            </Label>
          </div>
        </>
      )}
      {oneType && (
        <>
          <h3>{t("Item actions")}</h3>

          <ActionList
            name="actions"
            initialValue={actions}
            availableActions={availableActions}
          />
        </>
      )}
    </>
  );
};

export default React.memo(ItemForm);

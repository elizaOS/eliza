import React from "react";
import { useTranslation } from "react-i18next";
import { Field } from "react-final-form";

import Label from "../../ui/formUtils/Label";
import Hint from "../../ui/formUtils/Hint";

import ColorPicker from "../../ui/formUtils/ColorPicker";

const Form = ({ initialValues }) => {
  const { t } = useTranslation();
  return (
    <>
      <Label>
        {t("Label")}
        <Field
          name="label"
          component="input"
          initialValue={initialValues.label}
        />
      </Label>
      <Label>
        {t("Width")}
        <Field
          name="width"
          component="input"
          initialValue={initialValues.width}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>
      <Label>
        {t("Height")}
        <Field
          name="height"
          component="input"
          initialValue={initialValues.height}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>

      <Label>
        {t("Color 1")}
        <Field
          name="color"
          component="input"
          initialValue={initialValues.color}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker value={value} onChange={onChange} />
          )}
        </Field>
      </Label>

      <Label>
        {t("Color 2")}
        <Field
          name="alternateColor"
          component="input"
          initialValue={initialValues.alternateColor}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker value={value} onChange={onChange} />
          )}
        </Field>
      </Label>

      <Label>
        {t("Column count")}
        <Field
          name="colCount"
          component="input"
          initialValue={initialValues.colCount}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>

      <Label>
        {t("Row count")}
        <Field
          name="rowCount"
          component="input"
          initialValue={initialValues.rowCount}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>

      <Label>
        {t("Hold items")}
        <Field
          name="holdItems"
          component="input"
          type="checkbox"
          initialValue={initialValues.holdItems}
        />
        <Hint>
          {t(
            "Whether we can place items on it. When an item is placed, " +
              "moving the current item one also moves the placed items."
          )}
        </Hint>
      </Label>
    </>
  );
};

export default Form;

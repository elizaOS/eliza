import React from "react";
import { useTranslation } from "react-i18next";
import { Field } from "react-final-form";

import Label from "../../ui/formUtils/Label";
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
        {t("Background color")}
        <Field
          name="backgroundColor"
          component="input"
          initialValue={initialValues.backgroundColor || "#CCCCCC"}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker value={value} onChange={onChange} />
          )}
        </Field>
      </Label>
      <Label>
        {t("Border color")}
        <Field
          name="borderColor"
          component="input"
          initialValue={initialValues.borderColor || "#CCCCCC33"}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker
              value={value}
              onChange={onChange}
              disableAlpha={false}
            />
          )}
        </Field>
      </Label>
      <Label>
        {t("Border style")}
        <Field
          name="borderStyle"
          component="select"
          initialValue={initialValues.borderStyle || "dotted"}
          style={{ width: "10em" }}
        >
          <option value="dotted">{t("Dotted")}</option>
          <option value="Solid">{t("solid")}</option>
          <option value="dashed">{t("Dashed")}</option>
        </Field>
      </Label>
    </>
  );
};

export default Form;

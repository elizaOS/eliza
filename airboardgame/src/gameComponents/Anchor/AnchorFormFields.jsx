import React from "react";
import { useTranslation } from "react-i18next";
import { Field } from "react-final-form";

import Label from "../../ui/formUtils/Label";
import ColorPicker from "../../ui/formUtils/ColorPicker";
import Hint from "../../ui/formUtils/Hint";

const Form = ({ initialValues }) => {
  const { t } = useTranslation();
  return (
    <>
      <Label>
        {t("Label")}
        <Field
          name="label"
          component="input"
          initialValue={initialValues.label ?? initialValues.text}
        />
      </Label>

      <Label>
        {t("Snap families")}
        <Field
          name="families"
          component="input"
          format={(val) => val && val.join(",")}
          parse={(val) => val && val.split(",").map((v) => v.trim())}
          initialValue={initialValues.families || []}
        />
        <Hint>
          {t(
            "Let this field empty to snap all items, " +
              "or set a comma separated list of families that will be snapped."
          )}
        </Hint>
      </Label>

      <Label>
        {t("Color")}
        <Field
          name="color"
          component="input"
          initialValue={initialValues.color || "#CCC"}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker value={value} onChange={onChange} />
          )}
        </Field>
      </Label>
    </>
  );
};

export default Form;

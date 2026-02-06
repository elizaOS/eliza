import React from "react";
import { useTranslation } from "react-i18next";
import { Field } from "react-final-form";
import { useItemActions } from "react-sync-board";

import Label from "../../ui/formUtils/Label";
import Hint from "../../ui/formUtils/Hint";
import { ImageField } from "../../mediaLibrary";
import { uid } from "../../utils";

const Form = ({ initialValues }) => {
  const { t } = useTranslation();

  const { batchUpdateItems } = useItemActions();

  React.useEffect(() => {
    if (!initialValues.images) {
      // When selecting multiple images
      return;
    }
    if (initialValues.images.length < initialValues.side) {
      // Add empty element
      batchUpdateItems([initialValues.id], (prevItem) => {
        const newItem = { ...prevItem };
        newItem.images = [...newItem.images];
        newItem.images.push({ id: uid(), type: "empty" });
        return newItem;
      });
    }
    if (initialValues.images.length > initialValues.side) {
      // remove element
      batchUpdateItems([initialValues.id], (prevItem) => {
        const newItem = { ...prevItem };
        newItem.images = newItem.images.slice(0, newItem.images.length);
        newItem.images.pop();
        return newItem;
      });
    }
  }, [
    initialValues.side,
    initialValues.images,
    initialValues.id,
    batchUpdateItems,
  ]);

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
        {t("Roll on move")}
        <Field
          name="rollOnMove"
          component="input"
          type="checkbox"
          initialValue={initialValues.rollOnMove}
        />
        <Hint>{t("Check it to roll the dice after each move.")}</Hint>
      </Label>

      <Label>
        {t("Side count")}
        <Field
          name="side"
          component="input"
          initialValue={initialValues.side || 6}
        >
          {(props) => {
            const onChange = (newValue) => {
              const parsed = parseInt(newValue.target.value, 10);
              const nextValue = parsed > 1 ? parsed : 1;
              props.input.onChange(nextValue);
            };
            return (
              <input
                value={props.input.value}
                onChange={onChange}
                type="number"
              />
            );
          }}
        </Field>
      </Label>

      {(initialValues.images || []).map(({ id }, index) => {
        return (
          <Label key={id}>
            {t("Dice image {{index}}", { index: index + 1 })}
            <Field
              name={`images[${index}]`}
              initialValue={initialValues.images[index]}
            >
              {({ input: { value, onChange } }) => {
                return <ImageField value={value} onChange={onChange} />;
              }}
            </Field>
          </Label>
        );
      })}
    </>
  );
};

export default Form;

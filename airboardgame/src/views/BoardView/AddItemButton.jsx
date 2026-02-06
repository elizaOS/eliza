import React from "react";
import { useTranslation } from "react-i18next";
import ItemLibrary from "./ItemLibrary";

import NavButton from "../../ui/NavButton";
import SidePanel from "../../ui/SidePanel";

import { FiPlusCircle } from "react-icons/fi";

const AddItemPanel = ({ itemLibraries, open, onClose }) => {
  const [tab, setTab] = React.useState(itemLibraries[0]?.key || "standard");

  React.useEffect(() => {
    setTab(itemLibraries[0]?.key || "standard");
  }, [itemLibraries]);

  return (
    <SidePanel open={open} onClose={onClose} width="33%">
      <nav className="tabs">
        {itemLibraries.map(({ name, key }) => (
          <a
            onClick={() => setTab(key)}
            className={tab === key ? "active" : ""}
            style={{ cursor: "pointer" }}
            key={key}
          >
            {name}
          </a>
        ))}
      </nav>
      <section className="content">
        {itemLibraries.map(({ key, items }) =>
          tab === key ? <ItemLibrary items={items} key={key} /> : null
        )}
      </section>
    </SidePanel>
  );
};

const AddItemButton = ({ itemLibraries, showAddPanel, setShowAddPanel }) => {
  const { t } = useTranslation();

  return (
    <>
      <NavButton
        onClick={() => setShowAddPanel((prev) => !prev)}
        alt={t("Add item")}
        title={t("Add item")}
        Icon={FiPlusCircle}
      />
      <AddItemPanel
        itemLibraries={itemLibraries}
        open={showAddPanel}
        onClose={() => setShowAddPanel(false)}
      />
    </>
  );
};

export default AddItemButton;

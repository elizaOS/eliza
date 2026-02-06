describe("Selection action", () => {
  beforeEach(() => {
    cy.viewport(1000, 600);
    cy.intercept(
      {
        method: "GET",
        url: "/airboardgame/store/game*",
      },
      "[]"
    );
    cy.visit("/");
    cy.contains("0 Test game", { timeout: 10000 })
      .parent()
      .find(".img-wrapper")
      .click();
    // Way board loading
    cy.get(".board-pane", { timeout: 10000 }).should(
      "have.css",
      "transform",
      "matrix(0.24, 0, 0, 0.24, -5596.48, -5808.48)"
    );
    cy.get(".item")
      .first()
      .children()
      .first()
      .should("have.css", "transform", "none");
  });

  it("should select multiple items with right click ", () => {
    const posInit = {
      clientX: 400,
      clientY: 210,
    };
    cy.get(".board")
      .trigger("pointerdown", {
        buttons: 4,
        pointerId: 1,
        isPrimary: true,
        scrollBehavior: false,
        force: true,
        ...posInit,
      })
      .trigger("pointermove", {
        buttons: 4,
        force: true,
        pointerId: 1,
        isPrimary: true,
        scrollBehavior: false,
        clientX: posInit.clientX + 310,
        clientY: posInit.clientY + 260,
      });

    cy.get(".selection").should(
      "have.css",
      "transform",
      "matrix(1, 0, 0, 1, 405.92, 215.52)"
    );

    cy.get(".board").trigger("pointerup", {
      isPrimary: true,
      force: true,
    });

    cy.get("img[src='/game_assets/AS.jpg']")
      .parents(".item")
      .should("have.class", "selected");
    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .should("have.class", "selected");
    cy.get("img[src='/game_assets/BH.jpg']")
      .parents(".item")
      .should("have.class", "selected");
  });
});

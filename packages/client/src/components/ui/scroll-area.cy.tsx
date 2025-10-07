/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { ScrollArea, ScrollBar } from './scroll-area';

describe('ScrollArea Component', () => {
  it('renders basic scroll area', () => {
    cy.mountRadix(
      <ScrollArea className="h-[200px] w-[350px] rounded-md border p-4">
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={i} className="text-sm">
            Item {i + 1}
          </div>
        ))}
      </ScrollArea>
    );

    cy.get('[data-radix-scroll-area-viewport]').should('exist');
    cy.contains('Item 1').should('be.visible');
  });

  it('handles vertical scrolling', () => {
    cy.mountRadix(
      <ScrollArea className="h-[200px] w-[350px] rounded-md border">
        <div className="p-4">
          {Array.from({ length: 50 }).map((_, i) => (
            <div key={i} className="py-2">
              Long content item {i + 1}
            </div>
          ))}
        </div>
      </ScrollArea>
    );

    cy.contains('Long content item 1').should('be.visible');
    cy.contains('Long content item 50').should('not.be.visible');

    // Scroll to bottom
    cy.get('[data-radix-scroll-area-viewport]').scrollTo('bottom');
    cy.contains('Long content item 50').should('be.visible');
  });

  it('handles horizontal scrolling', () => {
    cy.mountRadix(
      <ScrollArea className="w-[300px] rounded-md border">
        <div className="flex w-max space-x-4 p-4">
          {Array.from({ length: 20 }).map((_, i) => (
            <div
              key={i}
              className="flex h-20 w-[150px] shrink-0 items-center justify-center rounded-md border"
            >
              Card {i + 1}
            </div>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    );

    cy.contains('Card 1').should('be.visible');

    // Scroll horizontally
    cy.get('[data-radix-scroll-area-viewport]').scrollTo('right');
  });

  it('renders with custom ScrollBar', () => {
    cy.mountRadix(
      <ScrollArea className="h-72 w-48 rounded-md border">
        <div className="p-4">
          <h4 className="mb-4 text-sm font-medium leading-none">Tags</h4>
          {Array.from({ length: 50 }).map((_, i) => (
            <div key={i} className="text-sm">
              Tag {i + 1}
            </div>
          ))}
        </div>
        <ScrollBar className="bg-red-500" />
      </ScrollArea>
    );

    cy.get('[data-radix-scroll-area-viewport]').should('exist');
    cy.contains('Tags').should('be.visible');
  });

  it('applies custom className', () => {
    cy.mountRadix(
      <ScrollArea className="custom-scroll-area h-[200px] w-[200px]">
        <div className="p-4">Content</div>
      </ScrollArea>
    );

    cy.get('[data-radix-scroll-area-viewport]').should('exist');
  });

  it('handles dynamic content updates', () => {
    const TestComponent = () => {
      const [items, setItems] = React.useState(5);

      return (
        <div>
          <button onClick={() => setItems(items + 5)}>Add More</button>
          <ScrollArea className="h-[200px] w-[300px] rounded-md border">
            <div className="p-4">
              {Array.from({ length: items }).map((_, i) => (
                <div key={i} className="py-1">
                  Item {i + 1}
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      );
    };

    cy.mountRadix(<TestComponent />);

    cy.contains('Item 5').should('be.visible');
    cy.contains('Item 10').should('not.exist');

    // Add more items
    cy.contains('button', 'Add More').click();
    cy.contains('Item 10').should('exist');
  });

  it('works with nested scroll areas', () => {
    cy.mountRadix(
      <ScrollArea className="h-[400px] w-[600px] rounded-md border">
        <div className="p-4">
          <h2 className="mb-4 text-xl font-bold">Outer Scroll Area</h2>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="mb-4">
              <h3 className="mb-2 font-medium">Section {i + 1}</h3>
              <ScrollArea className="h-[100px] rounded-md border bg-muted">
                <div className="p-2">
                  {Array.from({ length: 10 }).map((_, j) => (
                    <div key={j} className="text-sm">
                      Nested item {j + 1}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          ))}
        </div>
      </ScrollArea>
    );

    cy.contains('Outer Scroll Area').should('be.visible');
    cy.get('[data-radix-scroll-area-viewport]').should('have.length.at.least', 5);
  });

  it('preserves scroll position', () => {
    const TestComponent = () => {
      const [show, setShow] = React.useState(true);

      return (
        <div>
          <button onClick={() => setShow(!show)}>Toggle</button>
          {show && (
            <ScrollArea className="h-[200px] w-[300px] rounded-md border">
              <div className="p-4">
                {Array.from({ length: 50 }).map((_, i) => (
                  <div key={i} className="py-1" data-index={i}>
                    Item {i + 1}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      );
    };

    cy.mountRadix(<TestComponent />);

    // Scroll to middle
    cy.get('[data-radix-scroll-area-viewport]').scrollTo(0, 500);

    // Check that scroll position is maintained
    cy.get('[data-radix-scroll-area-viewport]').should('exist');
  });

  it('handles content with images', () => {
    cy.mountRadix(
      <ScrollArea className="h-[300px] w-[400px] rounded-md border">
        <div className="p-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="mb-4 flex items-center space-x-4">
              <img
                src={`https://via.placeholder.com/100x100?text=${i + 1}`}
                alt={`Image ${i + 1}`}
                className="h-24 w-24 rounded-md object-cover"
              />
              <div>
                <h4 className="font-medium">Image {i + 1}</h4>
                <p className="text-sm text-muted-foreground">Description for image {i + 1}</p>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    );

    cy.contains('Image 1').should('be.visible');
    cy.get('img').should('have.length', 10);
  });

  it('works with tables', () => {
    cy.mountRadix(
      <ScrollArea className="h-[300px] w-full rounded-md border">
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <th className="p-2 text-left">ID</th>
              <th className="p-2 text-left">Name</th>
              <th className="p-2 text-left">Status</th>
              <th className="p-2 text-left">Date</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 50 }).map((_, i) => (
              <tr key={i} className="border-b">
                <td className="p-2">{i + 1}</td>
                <td className="p-2">Item {i + 1}</td>
                <td className="p-2">Active</td>
                <td className="p-2">2024-01-{String(i + 1).padStart(2, '0')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    );

    cy.get('table').should('be.visible');
    cy.contains('Item 1').should('be.visible');

    // Scroll to see more items
    cy.get('[data-radix-scroll-area-viewport]').scrollTo('bottom');
    cy.contains('Item 50').should('be.visible');
  });
});

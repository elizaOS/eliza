/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card';

describe('Card Component', () => {
  it('renders basic card correctly', () => {
    cy.mount(
      <Card>
        <CardContent>Basic Card Content</CardContent>
      </Card>
    );

    cy.get('[data-slot="card"]').should('exist');
    cy.contains('Basic Card Content').should('be.visible');
  });

  it('renders complete card with all sections', () => {
    cy.mount(
      <Card>
        <CardHeader>
          <CardTitle>Card Title</CardTitle>
          <CardDescription>Card Description</CardDescription>
        </CardHeader>
        <CardContent>
          <p>Card content goes here</p>
        </CardContent>
        <CardFooter>
          <button>Action</button>
        </CardFooter>
      </Card>
    );

    // Check all sections are rendered
    cy.get('[data-slot="card"]').should('exist');
    cy.get('[data-slot="card-header"]').should('exist');
    cy.get('[data-slot="card-title"]').should('contain', 'Card Title');
    cy.get('[data-slot="card-description"]').should('contain', 'Card Description');
    cy.get('[data-slot="card-content"]').should('contain', 'Card content goes here');
    cy.get('[data-slot="card-footer"]').should('contain', 'Action');
  });

  it('applies custom className to card', () => {
    cy.mount(
      <Card className="custom-card bg-blue-500">
        <CardContent>Custom styled card</CardContent>
      </Card>
    );

    cy.get('[data-slot="card"]')
      .should('have.class', 'custom-card')
      .should('have.class', 'bg-blue-500');
  });

  it('renders card without header', () => {
    cy.mount(
      <Card>
        <CardContent>No header card</CardContent>
        <CardFooter>Footer only</CardFooter>
      </Card>
    );

    cy.get('[data-slot="card-header"]').should('not.exist');
    cy.get('[data-slot="card-content"]').should('exist');
    cy.get('[data-slot="card-footer"]').should('exist');
  });

  it('renders card without footer', () => {
    cy.mount(
      <Card>
        <CardHeader>
          <CardTitle>Header Only</CardTitle>
        </CardHeader>
        <CardContent>No footer card</CardContent>
      </Card>
    );

    cy.get('[data-slot="card-header"]').should('exist');
    cy.get('[data-slot="card-content"]').should('exist');
    cy.get('[data-slot="card-footer"]').should('not.exist');
  });

  it('supports nested content in card sections', () => {
    cy.mount(
      <Card>
        <CardHeader>
          <CardTitle>Complex Card</CardTitle>
          <CardDescription>
            <span className="text-red-500">Colored</span> description
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            <div>Row 1</div>
            <div>Row 2</div>
          </div>
        </CardContent>
      </Card>
    );

    // Check nested content renders correctly
    cy.get('.text-red-500').should('contain', 'Colored');
    cy.get('.grid').should('exist');
    cy.get('.grid').children().should('have.length', 2);
  });

  it('handles click events on card', () => {
    const onClick = cy.stub();

    cy.mount(
      <Card onClick={onClick} className="cursor-pointer">
        <CardContent>Clickable Card</CardContent>
      </Card>
    );

    cy.get('[data-slot="card"]').click();
    cy.wrap(onClick).should('have.been.calledOnce');
  });

  it('renders multiple cards in a grid', () => {
    cy.mount(
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent>Card 1</CardContent>
        </Card>
        <Card>
          <CardContent>Card 2</CardContent>
        </Card>
        <Card>
          <CardContent>Card 3</CardContent>
        </Card>
      </div>
    );

    cy.get('[data-slot="card"]').should('have.length', 3);
  });

  it('applies hover styles', () => {
    cy.mount(
      <Card className="hover:shadow-lg transition-shadow">
        <CardContent>Hover me</CardContent>
      </Card>
    );

    cy.get('[data-slot="card"]')
      .should('have.class', 'hover:shadow-lg')
      .should('have.class', 'transition-shadow');
  });

  it('supports data attributes', () => {
    cy.mount(
      <Card data-testid="custom-card" data-id="123">
        <CardContent>Card with data attributes</CardContent>
      </Card>
    );

    cy.get('[data-testid="custom-card"]').should('exist').should('have.attr', 'data-id', '123');
  });
});

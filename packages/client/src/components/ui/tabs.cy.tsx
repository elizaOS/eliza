/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

describe('Tabs Component', () => {
  it('renders basic tabs correctly', () => {
    cy.mountRadix(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
          <TabsTrigger value="tab3">Tab 3</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content for tab 1</TabsContent>
        <TabsContent value="tab2">Content for tab 2</TabsContent>
        <TabsContent value="tab3">Content for tab 3</TabsContent>
      </Tabs>
    );

    // Check tabs are rendered
    cy.contains('Tab 1').should('be.visible');
    cy.contains('Tab 2').should('be.visible');
    cy.contains('Tab 3').should('be.visible');

    // Check default content is visible
    cy.contains('Content for tab 1').should('be.visible');
    cy.contains('Content for tab 2').should('not.exist');
    cy.contains('Content for tab 3').should('not.exist');
  });

  it('switches between tabs on click', () => {
    cy.mountRadix(
      <Tabs defaultValue="home">
        <TabsList>
          <TabsTrigger value="home">Home</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="home">Home content</TabsContent>
        <TabsContent value="profile">Profile content</TabsContent>
        <TabsContent value="settings">Settings content</TabsContent>
      </Tabs>
    );

    // Initially home tab is active
    cy.contains('Home content').should('be.visible');

    // Click profile tab
    cy.contains('button', 'Profile').click();
    cy.contains('Profile content').should('be.visible');
    cy.contains('Home content').should('not.exist');

    // Click settings tab
    cy.contains('button', 'Settings').click();
    cy.contains('Settings content').should('be.visible');
    cy.contains('Profile content').should('not.exist');
  });

  it('works as controlled component', () => {
    const TestComponent = () => {
      const [activeTab, setActiveTab] = React.useState('tab1');

      return (
        <div>
          <p>Active tab: {activeTab}</p>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="tab1">First</TabsTrigger>
              <TabsTrigger value="tab2">Second</TabsTrigger>
            </TabsList>
            <TabsContent value="tab1">First content</TabsContent>
            <TabsContent value="tab2">Second content</TabsContent>
          </Tabs>
        </div>
      );
    };

    cy.mountRadix(<TestComponent />);

    cy.contains('Active tab: tab1').should('be.visible');
    cy.contains('First content').should('be.visible');

    cy.contains('button', 'Second').click();
    cy.contains('Active tab: tab2').should('be.visible');
    cy.contains('Second content').should('be.visible');
  });

  it('supports disabled tabs', () => {
    cy.mountRadix(
      <Tabs defaultValue="enabled">
        <TabsList>
          <TabsTrigger value="enabled">Enabled</TabsTrigger>
          <TabsTrigger value="disabled" disabled>
            Disabled
          </TabsTrigger>
          <TabsTrigger value="another">Another</TabsTrigger>
        </TabsList>
        <TabsContent value="enabled">Enabled content</TabsContent>
        <TabsContent value="disabled">Disabled content</TabsContent>
        <TabsContent value="another">Another content</TabsContent>
      </Tabs>
    );

    cy.contains('button', 'Disabled').should('be.disabled');
    cy.contains('button', 'Disabled').click({ force: true });
    cy.contains('Disabled content').should('not.exist');
    cy.contains('Enabled content').should('be.visible');
  });

  it('applies custom className', () => {
    cy.mountRadix(
      <Tabs defaultValue="tab1" className="custom-tabs">
        <TabsList className="custom-list bg-gray-200">
          <TabsTrigger value="tab1" className="custom-trigger">
            Tab 1
          </TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1" className="custom-content p-4">
          Content 1
        </TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
      </Tabs>
    );

    cy.get('.custom-tabs').should('exist');
    cy.get('.custom-list').should('have.class', 'bg-gray-200');
    cy.get('.custom-trigger').should('exist');
    cy.get('.custom-content').should('have.class', 'p-4');
  });

  it('handles keyboard navigation', () => {
    cy.mountRadix(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">First</TabsTrigger>
          <TabsTrigger value="tab2">Second</TabsTrigger>
          <TabsTrigger value="tab3">Third</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">First content</TabsContent>
        <TabsContent value="tab2">Second content</TabsContent>
        <TabsContent value="tab3">Third content</TabsContent>
      </Tabs>
    );

    // Focus first tab
    cy.contains('button', 'First').focus();

    // Arrow right should move to next tab
    cy.focused().type('{rightarrow}');
    cy.focused().should('contain', 'Second');

    // Arrow right again
    cy.focused().type('{rightarrow}');
    cy.focused().should('contain', 'Third');

    // Arrow left should move back
    cy.focused().type('{leftarrow}');
    cy.focused().should('contain', 'Second');
  });

  it('supports orientation prop', () => {
    cy.mountRadix(
      <Tabs defaultValue="tab1" orientation="vertical">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
          <TabsTrigger value="tab3">Tab 3</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
        <TabsContent value="tab3">Content 3</TabsContent>
      </Tabs>
    );

    cy.get('[data-orientation="vertical"]').should('exist');
  });

  it('renders complex content in tabs', () => {
    cy.mountRadix(
      <Tabs defaultValue="form">
        <TabsList>
          <TabsTrigger value="form">Form</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
        <TabsContent value="form">
          <form className="space-y-4">
            <input placeholder="Name" className="border p-2" />
            <textarea placeholder="Description" className="border p-2" />
            <button type="submit">Submit</button>
          </form>
        </TabsContent>
        <TabsContent value="preview">
          <div className="p-4 border rounded">
            <h3>Preview</h3>
            <p>Form data will appear here</p>
          </div>
        </TabsContent>
      </Tabs>
    );

    cy.get('input[placeholder="Name"]').should('be.visible');
    cy.get('textarea[placeholder="Description"]').should('be.visible');

    cy.contains('button', 'Preview').click();
    cy.contains('h3', 'Preview').should('be.visible');
    cy.contains('Form data will appear here').should('be.visible');
  });

  it('maintains tab state when content changes', () => {
    const TestComponent = () => {
      const [count, setCount] = React.useState(0);

      return (
        <div>
          <button onClick={() => setCount(count + 1)}>Increment: {count}</button>
          <Tabs defaultValue="tab1">
            <TabsList>
              <TabsTrigger value="tab1">Tab 1</TabsTrigger>
              <TabsTrigger value="tab2">Tab 2</TabsTrigger>
            </TabsList>
            <TabsContent value="tab1">Tab 1 content with count: {count}</TabsContent>
            <TabsContent value="tab2">Tab 2 content with count: {count}</TabsContent>
          </Tabs>
        </div>
      );
    };

    cy.mountRadix(<TestComponent />);

    // Select tab 2
    cy.contains('button', 'Tab 2').click();
    cy.contains('Tab 2 content with count: 0').should('be.visible');

    // Increment counter
    cy.contains('button', 'Increment: 0').click();

    // Tab 2 should still be selected
    cy.contains('Tab 2 content with count: 1').should('be.visible');
  });

  it('supports icons in tab triggers', () => {
    cy.mountRadix(
      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">
            <span className="flex items-center gap-2">
              <span>👤</span>
              <span>Users</span>
            </span>
          </TabsTrigger>
          <TabsTrigger value="settings">
            <span className="flex items-center gap-2">
              <span>⚙️</span>
              <span>Settings</span>
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="users">Users list</TabsContent>
        <TabsContent value="settings">Settings panel</TabsContent>
      </Tabs>
    );

    cy.contains('👤').should('be.visible');
    cy.contains('⚙️').should('be.visible');
    cy.contains('Users').should('be.visible');
    cy.contains('Settings').should('be.visible');
  });
});

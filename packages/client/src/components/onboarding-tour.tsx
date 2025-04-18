import { useEffect, useState } from 'react';
import Joyride, { CallBackProps, STATUS, ACTIONS } from 'react-joyride';
import { useOnboarding } from '@/hooks/use-onboarding';
import { useLocation } from 'react-router-dom';

export default function OnboardingTour() {
  const { onboardingCompleted, completeOnboarding } = useOnboarding();
  const [run, setRun] = useState(false);
  const location = useLocation();
  const [tourStep, setTourStep] = useState(0);

  // Home page tour steps
  const homeSteps = [
    {
      target: '.sidebar-logo',
      content:
        'Welcome to ElizaOS! This is your gateway to creating and managing intelligent AI agents.',
      disableBeacon: true,
      title: 'Welcome to ElizaOS',
    },
    {
      target: '.sidebar-create-button',
      content:
        'This is your main creation button. Click here to create new agents or rooms quickly.',
      title: 'Create Button',
    },
    {
      target: '.sidebar-online-section, .sidebar-offline-section',
      content:
        'Your agents are organized here. Online agents (green dot) are ready to chat, while offline agents need to be activated first.',
      title: 'Your Agents',
    },
    {
      target: '.sidebar-groups-section',
      content:
        'Access your agent groups from here to see collaborative conversations between multiple agents.',
      title: 'Groups Navigation',
    },
    {
      target: '.sidebar-docs-button, .sidebar-logs-button, .sidebar-settings-button',
      content: 'Access documentation, system logs, and global settings from these utility buttons.',
      title: 'System Utilities',
    },
    {
      target: '.sidebar-connection-status',
      content: 'This indicator shows your connection status to the ElizaOS server.',
      title: 'Connection Status',
    },
    {
      target: '.agents-section',
      content:
        'This is your main workspace showing all your agents. Active agents have a green dot, while inactive ones appear grayed out with an "Offline" label.',
      title: 'Agent Dashboard',
    },
    {
      target: '.message-button, .start-button',
      content:
        'Click "Message" to chat with active agents, or "Start" to activate offline agents first.',
      title: 'Agent Interaction',
    },
    {
      target: '.agent-info-button, .agent-settings-button',
      content: 'View agent details or configure settings using these buttons on each agent card.',
      title: 'Agent Management',
    },
    {
      target: '.groups-section',
      content:
        'This section displays your agent groups for collaborative interactions between multiple agents.',
      title: 'Agent Groups',
    },
    {
      target: '.groups-create-button',
      content:
        'Create a new group by clicking this button. Groups allow multiple agents to interact together.',
      title: 'Create New Group',
    },
    {
      target: '.create-agent-button',
      content: "Let's create your first agent! Click this button to get started.",
      title: 'Create Your First Agent',
      spotlightClicks: true,
    },
  ];

  const createAgentSteps = [
    {
      target: '.agent-form-name',
      content: 'Give your agent a name that reflects its purpose or personality.',
      title: 'Name Your Agent',
      disableBeacon: true,
    },
    {
      target: '.agent-form-system-prompt',
      content:
        "The system prompt defines your agent's behavior and capabilities. This is the most important field for shaping how your agent will respond.",
      title: 'Define Agent Behavior',
    },
    {
      target: '.tabs-list',
      content:
        'Switch between these tabs to configure different aspects of your agent such as content, style, plugins, and appearance.',
      title: 'Configuration Tabs',
    },
    {
      target: '.agent-form-submit',
      content: 'Click Save to create your agent and return to the dashboard.',
      title: 'Save Your Agent',
      spotlightClicks: true,
    },
  ];

  // Select which steps to show based on current route
  const steps =
    location.pathname === '/' ? homeSteps : location.pathname === '/create' ? createAgentSteps : [];

  // Start the tour when on the home page and not completed
  useEffect(() => {
    if (location.pathname === '/' && !onboardingCompleted && tourStep === 0) {
      // Small delay to ensure DOM elements are loaded
      const timer = setTimeout(() => {
        setRun(true);
      }, 1000);

      return () => clearTimeout(timer);
    } else if (location.pathname === '/create' && !onboardingCompleted && tourStep === 1) {
      // Continue the tour on the create page
      const timer = setTimeout(() => {
        setRun(true);
      }, 1000);

      return () => clearTimeout(timer);
    } else {
      setRun(false);
    }
  }, [location.pathname, onboardingCompleted, tourStep]);

  // Handle tour events
  const handleJoyrideCallback = (data: CallBackProps) => {
    const { status, index, type, action } = data;

    // If we finished the home page tour, update the tour step
    if (location.pathname === '/' && type === 'step:after' && index === homeSteps.length - 1) {
      setTourStep(1);
      setRun(false);
    }

    // Tour is finished or skipped
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED || action === ACTIONS.CLOSE) {
      completeOnboarding();
      setRun(false);
    }
  };

  // Don't render if onboarding is completed or no steps
  if (onboardingCompleted || steps.length === 0) {
    return null;
  }

  return (
    <Joyride
      callback={handleJoyrideCallback}
      continuous
      run={run}
      scrollToFirstStep
      showProgress
      showSkipButton
      steps={steps}
      floaterProps={{
        disableAnimation: false,
        styles: {
          floater: {
            filter: 'drop-shadow(0 10px 15px rgba(0, 0, 0, 0.25))',
          },
        },
      }}
      styles={{
        options: {
          primaryColor: '#3b82f6',
          backgroundColor: '#1f2937',
          textColor: '#f3f4f6',
          overlayColor: 'rgba(0, 0, 0, 0.6)',
          zIndex: 9999,
          arrowColor: '#1f2937',
          beaconSize: 36,
        },
        tooltip: {
          fontSize: '14px',
          padding: '16px',
          borderRadius: '10px',
          boxShadow: '0 10px 25px rgba(0, 0, 0, 0.3)',
        },
        tooltipContainer: {
          textAlign: 'left',
        },
        tooltipTitle: {
          fontSize: '16px',
          fontWeight: '600',
          marginBottom: '8px',
        },
        tooltipContent: {
          padding: '5px 0',
          fontSize: '14px',
          lineHeight: '1.5',
        },
        buttonClose: {
          color: '#9ca3af',
          opacity: 0.8,
        },
        buttonBack: {
          color: '#9ca3af',
          fontSize: '14px',
          fontWeight: '500',
          padding: '8px 12px',
          borderRadius: '6px',
          marginRight: '8px',
          transition: 'background-color 0.2s ease',
        },
        buttonNext: {
          backgroundColor: '#3b82f6',
          fontSize: '14px',
          fontWeight: '500',
          padding: '8px 16px',
          borderRadius: '6px',
          color: 'white',
          border: 'none',
          boxShadow: '0 4px 6px rgba(59, 130, 246, 0.3)',
          transition: 'all 0.2s ease',
        },
        buttonSkip: {
          color: '#9ca3af',
          fontSize: '14px',
          padding: '8px 12px',
          borderRadius: '6px',
          transition: 'background-color 0.2s ease',
        },
        spotlight: {
          borderRadius: '8px',
          backgroundColor: 'transparent',
        },
        overlay: {
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
        },
      }}
    />
  );
}

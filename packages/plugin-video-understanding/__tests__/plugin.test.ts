import { describe, it, expect } from 'vitest';
import { videoUnderstandingPlugin } from '../src/index';
import videoUnderstandingPluginDefault from '../src/index';
import { VideoService } from '../src/services/video';

describe('Video Understanding Plugin', () => {
  it('should export a valid plugin', () => {
    expect(videoUnderstandingPlugin).toBeDefined();
  });

  it('should have the correct name', () => {
    expect(videoUnderstandingPlugin.name).toBe('video-understanding');
  });

  it('should have a valid description', () => {
    expect(videoUnderstandingPlugin.description).toBe('Plugin for video understanding');
  });

  it('should register the VideoService', () => {
    expect(videoUnderstandingPlugin.services).toHaveLength(1);
    expect(videoUnderstandingPlugin.services[0]).toBe(VideoService);
  });

  it('should have no actions', () => {
    expect(videoUnderstandingPlugin.actions).toHaveLength(0);
  });

  it('should export the plugin as default export', () => {
    expect(videoUnderstandingPluginDefault).toBe(videoUnderstandingPlugin);
  });
});

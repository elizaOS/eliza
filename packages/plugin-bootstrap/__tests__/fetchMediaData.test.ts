import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchMediaData } from '../src/index';
import type { Media } from '@elizaos/core';

const buffer = Buffer.from('data');

// Helper to mock fetch
function mockFetch(response: {
  ok: boolean;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  contentType?: string;
}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    arrayBuffer: response.arrayBuffer,
    headers: {
      get: vi.fn().mockReturnValue(response.contentType || 'image/png'),
    },
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

describe('fetchMediaData', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches media from http url', async () => {
    const arrayBufferMock = vi.fn().mockResolvedValue(buffer);
    const fetchMock = mockFetch({
      ok: true,
      arrayBuffer: arrayBufferMock,
      contentType: 'image/jpeg',
    });

    const attachments: Media[] = [
      { url: 'https://example.com/img.jpg', contentType: 'image/jpeg' } as Media,
    ];

    const result = await fetchMediaData(attachments);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/img.jpg');
    expect(arrayBufferMock).toHaveBeenCalled();
    expect(result[0].mediaType).toBe('image/jpeg');
    expect(result[0].data).toBeInstanceOf(Buffer);
  });

  it('defaults to image/png when content type missing', async () => {
    const arrayBufferMock = vi.fn().mockResolvedValue(buffer);
    const fetchMock = mockFetch({ ok: true, arrayBuffer: arrayBufferMock });

    const attachments: Media[] = [{ url: 'https://example.com/img.png' } as Media];

    const result = await fetchMediaData(attachments);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/img.png');
    expect(result[0].mediaType).toBe('image/png');
    expect(result[0].data).toBeInstanceOf(Buffer);
  });

  it('throws when fetch returns non-ok status', async () => {
    mockFetch({ ok: false });
    const attachments: Media[] = [{ url: 'https://example.com/bad.jpg' } as Media];
    await expect(fetchMediaData(attachments)).rejects.toThrow(
      'Failed to fetch file: https://example.com/bad.jpg'
    );
  });

  it('throws when file path is not http/https', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const attachments: Media[] = [{ url: '/tmp/file.png' } as Media];
    await expect(fetchMediaData(attachments)).rejects.toThrow('File not found: /tmp/file.png');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

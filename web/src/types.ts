// Wire protocol shared with the backend (server/index.ts).

// One consolidated group of requests within a frame. `qty` is how many requests
// it represents; the viz expands it back into balls (sampled when huge).
export type Group = {
  path: string;
  status: number;
  qty: number;
  size: number;
  host?: string;
};

export type FrameMsg = {
  type: 'frame';
  t: number;
  groups: Group[];
};

export type ConfigMsg = {
  type: 'config';
  title: string;
  filtered: boolean;
};

export type ServerMsg = FrameMsg | ConfigMsg;

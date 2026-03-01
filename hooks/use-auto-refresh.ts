'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

const STORAGE_KEY = 'intuneget:auto-refresh-interval';
const DEFAULT_INTERVAL = 15; // minutes

export function getAutoRefreshInterval(): number {
  if (typeof window === 'undefined') return DEFAULT_INTERVAL;
  const stored = localStorage.getItem(STORAGE_KEY);
  const parsed = parseInt(stored || '', 10);
  return isNaN(parsed) ? DEFAULT_INTERVAL : parsed;
}

export function setAutoRefreshInterval(minutes: number): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, String(minutes));
}

/**
 * Automatically refreshes the current route on the configured interval.
 * Uses Next.js router.refresh() which re-fetches server components without
 * a full page reload.
 */
export function useAutoRefresh() {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const start = () => {
      if (timerRef.current) clearInterval(timerRef.current);
      const minutes = getAutoRefreshInterval();
      const ms = minutes * 60 * 1000;
      timerRef.current = setInterval(() => {
        router.refresh();
      }, ms);
    };

    start();

    // Re-start timer when the user changes the setting in another tab
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) start();
    };
    window.addEventListener('storage', handleStorage);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      window.removeEventListener('storage', handleStorage);
    };
  }, [router]);
}

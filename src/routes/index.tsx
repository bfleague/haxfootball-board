import { createFileRoute } from "@tanstack/react-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Arrow,
  Circle,
  Group,
  Image as KonvaImage,
  Layer,
  Rect,
  Stage,
  Text,
} from "react-konva";
import useImage from "use-image";
import { Download, Upload } from "lucide-react";
import { v4 as uuidv4 } from "uuid";

import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// ————————————————————————————————————————————
// Types & constants
// ————————————————————————————————————————————

type TeamColor = "red" | "blue";
type ArrowColor = "redLine" | "blueLine" | "yellow";

type BaseEl = {
  id: string;
  kind: "player" | "ball" | "arrow-straight" | "arrow-curve";
};

type PlayerEl = BaseEl & {
  kind: "player";
  x: number;
  y: number;
  color: TeamColor;
  avatar?: string; // up to 2 chars (not enforced at type-level)
  name?: string; // label under the circle
};

type BallEl = BaseEl & {
  kind: "ball";
  x: number;
  y: number;
};

type ArrowStraightEl = BaseEl & {
  kind: "arrow-straight";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: ArrowColor;
  dashed: boolean;
};

type ArrowCurveEl = BaseEl & {
  kind: "arrow-curve";
  points: Array<{ x: number; y: number }>;
  color: ArrowColor;
  dashed: boolean;
};

type El = PlayerEl | BallEl | ArrowStraightEl | ArrowCurveEl;

type Camera = { x: number; y: number; scale: number };

type BoardState = {
  elements: El[];
  camera: Camera;
  bg: {
    url: string | null;
    width: number; // in world units (px)
    height: number;
  };
};

export const Route = createFileRoute("/")({ component: HaxFootballBoard });

const PLAYER_RADIUS = 15; // stroke not counted
const PLAYER_BORDER = 2;
const BALL_RADIUS = 7; // stroke not counted
const BALL_BORDER = 2;
const LINE_WIDTH = 2;
const DASH: Array<number> = [10, 8];
const CURVE_MIN_DRAW_GAP = 5;
const CURVE_POINT_EPSILON = 0.75;
const HISTORY_LIMIT = 50;

const COLORS = {
  red: "#ef4444",
  blue: "#3b82f6",
  redLine: "#bd1111",
  blueLine: "#082ec7",
  yellow: "#eab308",
  black: "#000000",
  brownBall: "#8B5A2B",
  field: "#718c5a", // greenish
};

// Default background (set width/height; url optional)
const DEFAULT_BG = {
  url: "/bg.png" as string | null,
  width: 622,
  height: 564,
};

// ————————————————————————————————————————————
// Utilities
// ————————————————————————————————————————————

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function sampleCubicPoints(
  start: { x: number; y: number },
  control1: { x: number; y: number },
  control2: { x: number; y: number },
  end: { x: number; y: number },
  segments = 24,
): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    const x =
      mt2 * mt * start.x +
      3 * mt2 * t * control1.x +
      3 * mt * t2 * control2.x +
      t2 * t * end.x;
    const y =
      mt2 * mt * start.y +
      3 * mt2 * t * control1.y +
      3 * mt * t2 * control2.y +
      t2 * t * end.y;
    pts.push({ x, y });
  }
  return pts;
}

function prunePoints(
  points: Array<{ x: number; y: number }>,
  epsilon = CURVE_POINT_EPSILON,
): Array<{ x: number; y: number }> {
  const result: Array<{ x: number; y: number }> = [];
  for (const pt of points) {
    const prev = result[result.length - 1];
    if (!prev || Math.hypot(pt.x - prev.x, pt.y - prev.y) > epsilon) {
      result.push({ x: pt.x, y: pt.y });
    } else {
      result[result.length - 1] = { x: pt.x, y: pt.y };
    }
  }
  return result.length >= 2 ? result : points.slice(0, 2);
}

function cloneElements(elements: Array<El>): Array<El> {
  return elements.map((el) => {
    if (el.kind === "arrow-curve") {
      return {
        ...el,
        points: el.points.map((p) => ({ x: p.x, y: p.y })),
      };
    }
    return { ...el };
  });
}

function normalizeArrowColor(color: any): ArrowColor {
  if (color === "redLine" || color === "red") return "redLine";
  if (color === "blueLine" || color === "blue") return "blueLine";
  if (color === "yellow") return "yellow";
  return "blueLine";
}

function worldFromPointer(
  stage: import("konva").Stage,
  camera: Camera,
  viewport: { w: number; h: number },
) {
  const p = stage.getPointerPosition();
  if (!p) return { x: 0, y: 0 };
  const worldX = (p.x - viewport.w / 2 - camera.x) / camera.scale;
  const worldY = (p.y - viewport.h / 2 - camera.y) / camera.scale;
  return { x: worldX, y: worldY };
}

function cameraZoomTo(
  camera: Camera,
  anchorScreen: { x: number; y: number }, // screen coordinates to zoom around
  newScale: number,
  viewport: { w: number; h: number },
): Camera {
  // Keep world point under anchor fixed while scaling
  const worldX = (anchorScreen.x - viewport.w / 2 - camera.x) / camera.scale;
  const worldY = (anchorScreen.y - viewport.h / 2 - camera.y) / camera.scale;
  return {
    scale: newScale,
    x: anchorScreen.x - viewport.w / 2 - worldX * newScale,
    y: anchorScreen.y - viewport.h / 2 - worldY * newScale,
  };
}

// ————————————————————————————————————————————
// Background image helper
// ————————————————————————————————————————————

function Background({
  url,
  width,
  height,
}: {
  url: string | null;
  width: number;
  height: number;
}) {
  const [img] = useImage(url || "");
  // Draw solid field first, then image centered at (0,0)
  return (
    <Group>
      {/* giant field so panning always sees green */}
      <Rect
        x={-5000}
        y={-5000}
        width={10000}
        height={10000}
        fill={COLORS.field}
        listening={false}
      />
      {url && img && (
        <KonvaImage
          image={img}
          x={-width / 2}
          y={-height / 2}
          width={width}
          height={height}
          listening={false}
        />
      )}
    </Group>
  );
}

// ————————————————————————————————————————————
// Element renderers (each returns a Group that is draggable)
// ————————————————————————————————————————————

function PlayerNode({
  el,
  onMove,
  onContext,
  onSelect,
  highlighted = false,
}: {
  el: PlayerEl;
  onMove: (id: string, x: number, y: number) => void;
  onContext: (e: any, id: string) => void;
  onSelect: (id: string) => void;
  highlighted?: boolean;
}) {
  const fill = el.color === "red" ? COLORS.red : COLORS.blue;
  const AVATAR_FONT = 12;
  const NAME_FONT = 10;
  return (
    <Group
      x={el.x}
      y={el.y}
      draggable
      shadowEnabled={highlighted}
      shadowColor="#fbbf24"
      shadowBlur={highlighted ? 28 : 0}
      shadowOpacity={highlighted ? 0.85 : 0}
      shadowOffsetX={0}
      shadowOffsetY={0}
      onMouseDown={(e) => {
        if (e.evt.button === 0) onSelect(el.id);
      }}
      onTap={() => onSelect(el.id)}
      onDragEnd={(e) => {
        const node = e.target as import("konva").Node;
        const pos = node.position();
        onMove(el.id, pos.x, pos.y);
      }}
      onContextMenu={(e) => onContext(e, el.id)}
    >
      {highlighted && (
        <Circle
          radius={PLAYER_RADIUS + 2}
          fill="#facc1522"
          stroke="#facc15"
          strokeWidth={1.5}
          opacity={0.75}
          listening={false}
        />
      )}
      <Circle
        radius={PLAYER_RADIUS}
        stroke={COLORS.black}
        strokeWidth={PLAYER_BORDER}
        fill={fill}
      />
      {/* avatar text centered */}
      {el.avatar && (
        <Text
          text={el.avatar}
          fontStyle="bold"
          fontSize={AVATAR_FONT}
          fill="#fff"
          width={PLAYER_RADIUS * 2}
          align="center"
          offsetX={PLAYER_RADIUS}
          offsetY={AVATAR_FONT / 2}
        />
      )}
      {/* name 3px below */}
      {el.name && (
        <Text
          text={el.name}
          fontSize={NAME_FONT}
          fill="#111827"
          y={PLAYER_RADIUS + 3}
          width={PLAYER_RADIUS * 2}
          align="center"
          offsetX={PLAYER_RADIUS}
        />
      )}
    </Group>
  );
}

function BallNode({
  el,
  onMove,
  onContext,
  onSelect,
  highlighted = false,
}: {
  el: BallEl;
  onMove: (id: string, x: number, y: number) => void;
  onContext: (e: any, id: string) => void;
  onSelect: (id: string) => void;
  highlighted?: boolean;
}) {
  return (
    <Group
      x={el.x}
      y={el.y}
      draggable
      shadowEnabled={highlighted}
      shadowColor="#fbbf24"
      shadowBlur={highlighted ? 24 : 0}
      shadowOpacity={highlighted ? 0.85 : 0}
      shadowOffsetX={0}
      shadowOffsetY={0}
      onMouseDown={(e) => {
        if (e.evt.button === 0) onSelect(el.id);
      }}
      onTap={() => onSelect(el.id)}
      onDragEnd={(e) => {
        const node = e.target as import("konva").Node;
        const pos = node.position();
        onMove(el.id, pos.x, pos.y);
      }}
      onContextMenu={(e) => onContext(e, el.id)}
    >
      {highlighted && (
        <Circle
          radius={BALL_RADIUS + 2}
          fill="#facc1522"
          stroke="#facc15"
          strokeWidth={1.5}
          opacity={0.75}
          listening={false}
        />
      )}
      <Circle
        radius={BALL_RADIUS}
        stroke={COLORS.black}
        strokeWidth={BALL_BORDER}
        fill={COLORS.brownBall}
      />
    </Group>
  );
}

function StraightArrowNode({
  el,
  onMove,
  onContext,
  onSelect,
  highlighted = false,
}: {
  el: ArrowStraightEl;
  onMove: (id: string, dx: number, dy: number) => void;
  onContext: (e: any, id: string) => void;
  onSelect: (id: string) => void;
  highlighted?: boolean;
}) {
  const stroke = COLORS[el.color];
  return (
    <Group>
      {highlighted && (
        <Arrow
          points={[el.x1, el.y1, el.x2, el.y2]}
          stroke="#facc15"
          fill="#facc15"
          opacity={0.28}
          strokeWidth={LINE_WIDTH + 4}
          pointerLength={14}
          pointerWidth={14}
          dash={el.dashed ? DASH : undefined}
          listening={false}
        />
      )}
      <Arrow
        points={[el.x1, el.y1, el.x2, el.y2]}
        stroke={stroke}
        fill={stroke}
        strokeWidth={LINE_WIDTH}
        dash={el.dashed ? DASH : undefined}
        pointerLength={10}
        pointerWidth={10}
        onMouseDown={(e) => {
          if (e.evt.button === 0) onSelect(el.id);
        }}
        onTap={() => onSelect(el.id)}
        onContextMenu={(e) => onContext(e, el.id)}
        draggable
        onDragEnd={(e) => {
          const node = e.target as import("konva").Node & {
            x(): number;
            y(): number;
          };
          const dx = node.x();
          const dy = node.y();
          onMove(el.id, dx, dy);
          node.position({ x: 0, y: 0 });
        }}
      />
    </Group>
  );
}

function CurvedArrowNode({
  el,
  onMove,
  onContext,
  onSelect,
  highlighted = false,
}: {
  el: ArrowCurveEl;
  onMove: (id: string, dx: number, dy: number) => void;
  onContext: (e: any, id: string) => void;
  onSelect: (id: string) => void;
  highlighted?: boolean;
}) {
  if (el.points.length < 2) return null;
  const stroke = COLORS[el.color];
  const points = el.points.flatMap((p) => [p.x, p.y]);
  return (
    <Group>
      {highlighted && (
        <Arrow
          points={points}
          tension={0.45}
          stroke="#facc15"
          fill="#facc15"
          opacity={0.28}
          strokeWidth={LINE_WIDTH + 4}
          pointerLength={14}
          pointerWidth={14}
          dash={el.dashed ? DASH : undefined}
          listening={false}
        />
      )}
      <Arrow
        points={points}
        tension={0.45}
        stroke={stroke}
        fill={stroke}
        strokeWidth={LINE_WIDTH}
        dash={el.dashed ? DASH : undefined}
        pointerLength={10}
        pointerWidth={10}
        onMouseDown={(e) => {
          if (e.evt.button === 0) onSelect(el.id);
        }}
        onTap={() => onSelect(el.id)}
        onContextMenu={(e) => onContext(e, el.id)}
        draggable
        onDragEnd={(e) => {
          const node = e.target as import("konva").Node & {
            x(): number;
            y(): number;
          };
          const dx = node.x();
          const dy = node.y();
          onMove(el.id, dx, dy);
          node.position({ x: 0, y: 0 });
        }}
      />
    </Group>
  );
}

// ————————————————————————————————————————————
// Main component
// ————————————————————————————————————————————

export default function HaxFootballBoard() {
  // Viewport size
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef =
    useRef<
      import("react-konva").KonvaNodeComponent<import("konva").Stage, any>
    >(null);
  const [vp, setVp] = useState<{ w: number; h: number }>({
    w: window.innerWidth,
    h: window.innerHeight,
  });
  useEffect(() => {
    const onResize = () =>
      setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Camera
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1.5 });

  // Tools state
  type Tool =
    | "select"
    | "spawn-player"
    | "spawn-ball"
    | "arrow-straight"
    | "arrow-curve";
  const [tool, setTool] = useState<Tool>("select");
  const [currentArrowColor, setCurrentArrowColor] =
    useState<ArrowColor>("blueLine");
  const [currentDashed, setCurrentDashed] = useState(false);
  const [previewArrow, setPreviewArrow] = useState<
    ArrowStraightEl | ArrowCurveEl | null
  >(null);

  // Elements state — serializable
  const [elements, setElements] = useState<El[]>(() => {
    const init: El[] = [
      { id: uuidv4(), kind: "ball", x: 0, y: 0 },
      {
        id: uuidv4(),
        kind: "player",
        x: 25,
        y: 0,
        color: "blue",
        avatar: "QB",
      },
      {
        id: uuidv4(),
        kind: "player",
        x: 20,
        y: 150,
        color: "blue",
        avatar: "WR",
        name: "CWR",
      },
      {
        id: uuidv4(),
        kind: "player",
        x: 20,
        y: -130,
        color: "blue",
        avatar: "WR",
        name: "CWR",
      },
      {
        id: uuidv4(),
        kind: "player",
        x: 20,
        y: -225,
        color: "blue",
        avatar: "WR",
        name: "DWR",
      },
      {
        id: uuidv4(),
        kind: "player",
        x: -40,
        y: -70,
        color: "red",
        avatar: "CB",
      },
      {
        id: uuidv4(),
        kind: "player",
        x: -150,
        y: -35,
        color: "red",
        avatar: "LB",
      },
      {
        id: uuidv4(),
        kind: "player",
        x: -160,
        y: 35,
        color: "red",
        avatar: "LB",
      },
      {
        id: uuidv4(),
        kind: "player",
        x: -40,
        y: 70,
        color: "red",
        avatar: "CB",
      },
    ];
    return init;
  });

  const state: BoardState = useMemo(
    () => ({ elements, camera, bg: { ...DEFAULT_BG } }),
    [elements, camera],
  );

  // Export / Import JSON
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importText, setImportText] = useState("");

  // Context menu (custom, lightweight)
  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    id: string | null;
  }>({ open: false, x: 0, y: 0, id: null });
  const closeCtx = useCallback(
    () => setCtxMenu((c) => ({ ...c, open: false, id: null })),
    [],
  );
  const ctxRef = useRef<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // History for undo
  const historyRef = useRef<Array<El[]>>([]);
  const isUndoingRef = useRef(false);

  const pushHistory = useCallback((snapshot: El[]) => {
    const cloned = cloneElements(snapshot);
    historyRef.current.push(cloned);
    if (historyRef.current.length > HISTORY_LIMIT) {
      historyRef.current.shift();
    }
  }, []);

  const applyElementsUpdate = useCallback(
    (updater: (prev: Array<El>) => Array<El>) => {
      setElements((prev) => {
        const next = updater(prev);
        if (!isUndoingRef.current && next !== prev) {
          pushHistory(prev);
        }
        return next;
      });
    },
    [pushHistory],
  );

  const replaceElements = useCallback(
    (next: Array<El>) => {
      setElements((prev) => {
        if (!isUndoingRef.current) {
          pushHistory(prev);
        }
        return cloneElements(next);
      });
      setSelectedId(null);
    },
    [pushHistory],
  );

  const undo = useCallback(() => {
    const snapshot = historyRef.current.pop();
    if (!snapshot) return;
    isUndoingRef.current = true;
    setElements(cloneElements(snapshot));
    isUndoingRef.current = false;
  }, []);

  const ctxTarget = useMemo(
    () => elements.find((e) => e.id === ctxMenu.id),
    [elements, ctxMenu.id],
  );
  useEffect(() => {
    if (selectedId && !elements.some((e) => e.id === selectedId)) {
      setSelectedId(null);
    }
  }, [elements, selectedId]);
  const highlightedId = selectedId;
  const handleSelectElement = useCallback(
    (id: string) => {
      setSelectedId(id);
      closeCtx();
    },
    [closeCtx],
  );

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 0) {
        const target = event.target as Node | null;
        const isInsideCanvas =
          containerRef.current &&
          target &&
          containerRef.current.contains(target);
        const isInsideContext =
          ctxRef.current && target && ctxRef.current.contains(target);
        if (!isInsideCanvas && !isInsideContext) {
          setSelectedId(null);
        }
      }
      if (!ctxMenu.open) return;
      const target = event.target as Node | null;
      if (ctxRef.current && target && ctxRef.current.contains(target)) return;
      closeCtx();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [ctxMenu.open, closeCtx]);

  // Dragging state for panning (Space or Middle mouse)
  const [isPanning, setIsPanning] = useState(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const spaceDownRef = useRef(false);

  // Pointer-relative zoom (wheel)
  const handleWheel = useCallback(
    (e: any) => {
      e.evt.preventDefault();
      const stage = e.target.getStage();
      const pointer = stage.getPointerPosition();
      if (!pointer) return;

      const scaleBy = 1.05;
      const direction = e.evt.deltaY > 0 ? 1 : -1;
      const newScale = clamp(
        direction > 0 ? camera.scale / scaleBy : camera.scale * scaleBy,
        0.2,
        4,
      );

      setCamera((cam) => cameraZoomTo(cam, pointer, newScale, vp));
    },
    [camera.scale, vp],
  );

  // Panning (Space/Middle or left drag on empty canvas while selecting)
  const handleMouseDown = useCallback(
    (e: any) => {
      const stage = e.target.getStage();
      const isMiddle = e.evt.button === 1;
      const isPrimary = e.evt.button === 0;
      const clickedStage = e.target === stage;
      if (isPrimary && ctxMenu.open) {
        closeCtx();
      }
      if (isPrimary && clickedStage) {
        setSelectedId(null);
      }
      if (
        spaceDownRef.current ||
        isMiddle ||
        (isPrimary && clickedStage && tool === "select")
      ) {
        setIsPanning(true);
        lastPointerRef.current = stage?.getPointerPosition() ?? null;
      }
    },
    [tool, closeCtx, ctxMenu.open, setSelectedId],
  );

  const handleMouseMove = useCallback(
    (e: any) => {
      if (!isPanning) return;
      const stage = e.target.getStage();
      const p = stage.getPointerPosition();
      if (!p || !lastPointerRef.current) return;
      const dx = p.x - lastPointerRef.current.x;
      const dy = p.y - lastPointerRef.current.y;
      setCamera((cam) => ({ ...cam, x: cam.x + dx, y: cam.y + dy }));
      lastPointerRef.current = p;
    },
    [isPanning],
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    lastPointerRef.current = null;
  }, []);

  // Create spawns
  const spawnAt = useCallback(
    (
      el: Omit<PlayerEl, "id" | "kind"> | Omit<BallEl, "id" | "kind">,
      kind: "player" | "ball",
    ) => {
      applyElementsUpdate((els) =>
        els.concat([{ id: uuidv4(), kind, ...(el as any) }]),
      );
    },
    [applyElementsUpdate],
  );

  const setDragPreview = useCallback(
    (event: React.DragEvent, type: "player" | "ball") => {
      if (typeof document === "undefined") return;
      const size =
        type === "player"
          ? PLAYER_RADIUS * 2 + PLAYER_BORDER * 2
          : BALL_RADIUS * 2 + BALL_BORDER * 2;
      const preview = document.createElement("div");
      preview.style.width = `${size}px`;
      preview.style.height = `${size}px`;
      preview.style.borderRadius = "9999px";
      preview.style.backgroundColor =
        type === "player" ? COLORS.blue : COLORS.brownBall;
      preview.style.border = `${
        type === "player" ? PLAYER_BORDER : BALL_BORDER
      }px solid ${COLORS.black}`;
      preview.style.boxShadow = "0 6px 16px rgba(0,0,0,0.35)";
      preview.style.position = "fixed";
      preview.style.top = "-1000px";
      preview.style.left = "-1000px";
      preview.style.pointerEvents = "none";
      document.body.appendChild(preview);
      event.dataTransfer?.setDragImage(preview, size / 2, size / 2);
      requestAnimationFrame(() => {
        preview.remove();
      });
    },
    [],
  );

  const normalizeImportedElements = useCallback((raw: any[]): El[] => {
    const mapped = raw
      .map((el) => {
        if (!el || typeof el !== "object") return null;
        if (el.kind === "arrow-curve") {
          if (Array.isArray(el.points) && el.points.length >= 2) {
            const points = prunePoints(
              el.points
                .map((p: any) => ({
                  x: Number(p?.x) || 0,
                  y: Number(p?.y) || 0,
                }))
                .filter(
                  (p: { x: number; y: number }) =>
                    Number.isFinite(p.x) && Number.isFinite(p.y),
                ),
            );
            if (points.length < 2) return null;
            const color = normalizeArrowColor(el.color);
            return {
              id: el.id ?? uuidv4(),
              kind: "arrow-curve",
              points,
              color,
              dashed: Boolean(el.dashed),
            } as ArrowCurveEl;
          }
          if (
            typeof el.x1 === "number" &&
            typeof el.y1 === "number" &&
            typeof el.x2 === "number" &&
            typeof el.y2 === "number" &&
            typeof el.cx1 === "number" &&
            typeof el.cy1 === "number" &&
            typeof el.cx2 === "number" &&
            typeof el.cy2 === "number"
          ) {
            const points = prunePoints(
              sampleCubicPoints(
                { x: el.x1, y: el.y1 },
                { x: el.cx1, y: el.cy1 },
                { x: el.cx2, y: el.cy2 },
                { x: el.x2, y: el.y2 },
              ),
            );
            const color = normalizeArrowColor(el.color);
            return {
              id: el.id ?? uuidv4(),
              kind: "arrow-curve",
              points,
              color,
              dashed: Boolean(el.dashed),
            } as ArrowCurveEl;
          }
          return null;
        }
        if (el.kind === "arrow-straight") {
          const x1 = Number(el.x1);
          const y1 = Number(el.y1);
          const x2 = Number(el.x2);
          const y2 = Number(el.y2);
          if (
            Number.isFinite(x1) &&
            Number.isFinite(y1) &&
            Number.isFinite(x2) &&
            Number.isFinite(y2)
          ) {
            return {
              id: el.id ?? uuidv4(),
              kind: "arrow-straight",
              x1,
              y1,
              x2,
              y2,
              color: normalizeArrowColor(el.color),
              dashed: Boolean(el.dashed),
            } as ArrowStraightEl;
          }
          return null;
        }
        return el as El;
      })
      .filter((el): el is El => Boolean(el));
    return cloneElements(mapped);
  }, []);

  // Toolbox click handlers
  const handleSpawnClick = (what: "player" | "ball") => {
    if (what === "player")
      spawnAt(
        {
          x: 0,
          y: 0,
          color: "blue" as TeamColor,
          avatar: undefined,
          name: undefined,
        },
        "player",
      );
    else spawnAt({ x: 0, y: 0 }, "ball");
  };

  // Drag & drop from toolbox (optional UX)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer?.getData("text/plain");
      if (!type) return;
      const stage = stageRef.current?.getStage();
      if (!stage) return;
      const rect = container.getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const worldX = (screen.x - vp.w / 2 - camera.x) / camera.scale;
      const worldY = (screen.y - vp.h / 2 - camera.y) / camera.scale;
      if (type === "player") {
        spawnAt({ x: worldX, y: worldY, color: "blue" }, "player");
      } else if (type === "ball") {
        spawnAt({ x: worldX, y: worldY }, "ball");
      }
    };
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);
    return () => {
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
    };
  }, [camera, vp, spawnAt]);

  // Drawing arrows (as a brush)
  const drawState = useRef<
    | null
    | { kind: "arrow-straight"; start: { x: number; y: number } }
    | { kind: "arrow-curve"; points: Array<{ x: number; y: number }> }
  >(null);

  const onStageMouseDown = useCallback(
    (e: any) => {
      if (spaceDownRef.current || e.evt.button === 1) return; // already handled by panning
      const stage = e.target.getStage();
      const pointer = stage.getPointerPosition();
      if (!pointer) return;

      if (tool === "arrow-straight") {
        const world = worldFromPointer(stage, camera, vp);
        setPreviewArrow(null);
        drawState.current = { kind: "arrow-straight", start: world };
      } else if (tool === "arrow-curve") {
        const world = worldFromPointer(stage, camera, vp);
        setPreviewArrow(null);
        drawState.current = { kind: "arrow-curve", points: [world] };
      }
    },
    [tool, camera, vp, setPreviewArrow],
  );

  const onStageMouseMove = useCallback(
    (e: any) => {
      if (!drawState.current) return;
      const stage = e.target.getStage();
      const world = worldFromPointer(stage, camera, vp);

      if (drawState.current.kind === "arrow-straight") {
        const { start } = drawState.current;
        const id = "__preview";
        const preview: ArrowStraightEl = {
          id,
          kind: "arrow-straight",
          x1: start.x,
          y1: start.y,
          x2: world.x,
          y2: world.y,
          color: currentArrowColor,
          dashed: currentDashed,
        };
        setPreviewArrow(preview);
      } else {
        const minSegment = CURVE_MIN_DRAW_GAP / camera.scale;
        const id = "__preview";
        const state = drawState.current;
        const pts = state.points;
        if (pts.length === 1) {
          pts.push(world);
        } else {
          const lastIdx = pts.length - 1;
          const last = pts[lastIdx];
          const dist = Math.hypot(world.x - last.x, world.y - last.y);
          if (dist >= minSegment) {
            pts.push(world);
          } else {
            pts[lastIdx] = world;
          }
        }
        const previewPoints = state.points.map((p) => ({ ...p }));
        const preview: ArrowCurveEl = {
          id,
          kind: "arrow-curve",
          points: previewPoints,
          color: currentArrowColor,
          dashed: currentDashed,
        };
        setPreviewArrow(preview);
      }
    },
    [
      camera,
      currentArrowColor,
      currentDashed,
      vp,
      setPreviewArrow,
      applyElementsUpdate,
    ],
  );

  const onStageMouseUp = useCallback(
    (e: any) => {
      if (!drawState.current) return;
      const stage = e.target.getStage();
      const world = worldFromPointer(stage, camera, vp);
      const { kind } = drawState.current;

      if (kind === "arrow-straight") {
        const { start } = drawState.current;
        const el: ArrowStraightEl = {
          id: uuidv4(),
          kind: "arrow-straight",
          x1: start.x,
          y1: start.y,
          x2: world.x,
          y2: world.y,
          color: currentArrowColor,
          dashed: currentDashed,
        };
        applyElementsUpdate((els) => els.concat(el));
      } else {
        const pts = drawState.current.points.map((p) => ({ ...p }));
        if (pts.length === 0) {
          drawState.current = null;
          setPreviewArrow(null);
          return;
        }
        if (pts.length === 1) {
          pts.push({ x: world.x, y: world.y });
        } else {
          pts[pts.length - 1] = { x: world.x, y: world.y };
        }
        const filtered = prunePoints(pts);
        if (filtered.length < 2) {
          drawState.current = null;
          setPreviewArrow(null);
          return;
        }
        const el: ArrowCurveEl = {
          id: uuidv4(),
          kind: "arrow-curve",
          points: filtered,
          color: currentArrowColor,
          dashed: currentDashed,
        };
        applyElementsUpdate((els) => els.concat(el));
      }
      setPreviewArrow(null);
      drawState.current = null;
    },
    [camera, currentArrowColor, currentDashed, vp, setPreviewArrow],
  );

  // Move handlers (immutably update)
  const movePlayer = (id: string, x: number, y: number) =>
    applyElementsUpdate((els) =>
      els.map((e) => (e.id === id ? { ...(e as PlayerEl), x, y } : e)),
    );
  const moveBall = (id: string, x: number, y: number) =>
    applyElementsUpdate((els) =>
      els.map((e) => (e.id === id ? { ...(e as BallEl), x, y } : e)),
    );
  const moveStraight = (id: string, dx: number, dy: number) =>
    applyElementsUpdate((els) =>
      els.map((e) =>
        e.id === id
          ? {
              ...(e as ArrowStraightEl),
              x1: (e as ArrowStraightEl).x1 + dx,
              y1: (e as ArrowStraightEl).y1 + dy,
              x2: (e as ArrowStraightEl).x2 + dx,
              y2: (e as ArrowStraightEl).y2 + dy,
            }
          : e,
      ),
    );
  const moveCurve = (id: string, dx: number, dy: number) =>
    applyElementsUpdate((els) =>
      els.map((e) =>
        e.id === id
          ? {
              ...(e as ArrowCurveEl),
              points: (e as ArrowCurveEl).points.map((p) => ({
                x: p.x + dx,
                y: p.y + dy,
              })),
            }
          : e,
      ),
    );

  // Context menu open from shapes
  const openCtx = (evt: any, id: string) => {
    evt.evt.preventDefault();
    const { clientX, clientY } = evt.evt;
    setCtxMenu({ open: true, x: clientX, y: clientY, id });
  };

  // Update helpers for context actions
  const updateElement = useCallback(
    (id: string, patch: Partial<PlayerEl & ArrowStraightEl & ArrowCurveEl>) => {
      applyElementsUpdate((els) =>
        els.map((e) => (e.id === id ? ({ ...e, ...patch } as any) : e)),
      );
    },
    [applyElementsUpdate],
  );
  const deleteElement = useCallback(
    (id: string) => {
      setSelectedId((current) => (current === id ? null : current));
      applyElementsUpdate((els) => els.filter((e) => e.id !== id));
    },
    [applyElementsUpdate],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable =
        tagName === "input" ||
        tagName === "textarea" ||
        (target as HTMLElement | null)?.isContentEditable;
      if (!isEditable && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        if (e.key === "Delete" && selectedId) {
          e.preventDefault();
          closeCtx();
          deleteElement(selectedId);
          return;
        }
      }
      if (e.code === "Space") spaceDownRef.current = true;
      if (e.key >= "1" && e.key <= "5") {
        const scaleShortcut = {
          "1": 1.25,
          "2": 1.5,
          "3": 2,
          "4": 2.25,
          "5": 2.5,
        } as const;
        const newScale = (scaleShortcut as any)[e.key];
        const stage = stageRef.current?.getStage();
        if (!stage) return;
        const center = { x: vp.w / 2, y: vp.h / 2 };
        setCamera((cam) => cameraZoomTo(cam, center, newScale, vp));
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDownRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [vp, undo, selectedId, closeCtx, deleteElement]);

  // ————————————————————————————————————————————
  // Render
  // ————————————————————————————————————————————
  return (
    <div
      ref={containerRef}
      className="relative h-screen w-screen overflow-hidden bg-neutral-900"
    >
      {/* Canvas */}
      <Stage
        ref={stageRef as any}
        width={vp.w}
        height={vp.h}
        onWheel={handleWheel}
        onMouseDown={(e) => {
          handleMouseDown(e);
          onStageMouseDown(e);
        }}
        onMouseMove={(e) => {
          handleMouseMove(e);
          onStageMouseMove(e);
        }}
        onMouseUp={(e) => {
          handleMouseUp();
          onStageMouseUp(e);
        }}
        onContextMenu={(e) => e.evt.preventDefault()} // disable default
      >
        <Layer>
          {/* World group with camera transform; center of board is (0,0) */}
          <Group
            x={vp.w / 2 + camera.x}
            y={vp.h / 2 + camera.y}
            scaleX={camera.scale}
            scaleY={camera.scale}
          >
            {/* Background */}
            <Background
              url={DEFAULT_BG.url}
              width={DEFAULT_BG.width}
              height={DEFAULT_BG.height}
            />

            {/* Elements */}
            {elements.map((el) => {
              switch (el.kind) {
                case "player":
                  return (
                    <PlayerNode
                      key={el.id}
                      el={el}
                      onMove={movePlayer}
                      onContext={openCtx}
                      onSelect={handleSelectElement}
                      highlighted={highlightedId === el.id}
                    />
                  );
                case "ball":
                  return (
                    <BallNode
                      key={el.id}
                      el={el}
                      onMove={moveBall}
                      onContext={openCtx}
                      onSelect={handleSelectElement}
                      highlighted={highlightedId === el.id}
                    />
                  );
                case "arrow-straight":
                  return (
                    <StraightArrowNode
                      key={el.id}
                      el={el}
                      onMove={moveStraight}
                      onContext={openCtx}
                      onSelect={handleSelectElement}
                      highlighted={highlightedId === el.id}
                    />
                  );
                case "arrow-curve":
                  return (
                    <CurvedArrowNode
                      key={el.id}
                      el={el}
                      onMove={moveCurve}
                      onContext={openCtx}
                      onSelect={handleSelectElement}
                      highlighted={highlightedId === el.id}
                    />
                  );
              }
            })}

            {/* Brush preview (not committed) */}
            {previewArrow && previewArrow.kind === "arrow-straight" && (
              <Arrow
                points={[
                  previewArrow.x1,
                  previewArrow.y1,
                  previewArrow.x2,
                  previewArrow.y2,
                ]}
                stroke={COLORS[previewArrow.color]}
                fill={COLORS[previewArrow.color]}
                strokeWidth={LINE_WIDTH}
                dash={previewArrow.dashed ? DASH : undefined}
                pointerLength={10}
                pointerWidth={10}
                listening={false}
              />
            )}
            {previewArrow &&
              previewArrow.kind === "arrow-curve" &&
              previewArrow.points.length >= 2 && (
                <Arrow
                  points={previewArrow.points.flatMap((p) => [p.x, p.y])}
                  tension={0.45}
                  stroke={COLORS[previewArrow.color]}
                  fill={COLORS[previewArrow.color]}
                  strokeWidth={LINE_WIDTH}
                  dash={previewArrow.dashed ? DASH : undefined}
                  pointerLength={10}
                  pointerWidth={10}
                  listening={false}
                />
              )}
          </Group>
        </Layer>
      </Stage>

      {/* Floating toolbox */}
      <div className="pointer-events-none">
        <div className="pointer-events-auto fixed top-4 right-4 z-50 flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="secondary"
                className="!bg-stone-800 !text-white shadow-lg hover:!bg-stone-700"
                onClick={() => setExportDialogOpen(true)}
                aria-label="Export JSON"
              >
                <Download className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={8}>Export JSON</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="secondary"
                className="!bg-stone-800 !text-white shadow-lg hover:!bg-stone-700"
                onClick={() => setImportDialogOpen(true)}
                aria-label="Import JSON"
              >
                <Upload className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={8}>Import JSON</TooltipContent>
          </Tooltip>
        </div>

        <div className="pointer-events-auto fixed bottom-6 right-6 z-50 max-w-4xl">
          <div className="rounded-2xl border border-white/10 bg-neutral-950/90 px-6 py-5 text-white shadow-2xl backdrop-blur-xl">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  draggable
                  className="border border-white/20 !bg-white/10 !text-white hover:!bg-white/20"
                  onDragStart={(e) => {
                    e.dataTransfer?.setData("text/plain", "player");
                    setDragPreview(e, "player");
                  }}
                  onClick={() => handleSpawnClick("player")}
                >
                  + PLAYER
                </Button>
                <Button
                  variant="secondary"
                  draggable
                  className="border border-white/20 !bg-white/10 !text-white hover:!bg-white/20"
                  onDragStart={(e) => {
                    e.dataTransfer?.setData("text/plain", "ball");
                    setDragPreview(e, "ball");
                  }}
                  onClick={() => handleSpawnClick("ball")}
                >
                  + BALL
                </Button>
              </div>

              <ToggleGroup
                type="single"
                value={tool}
                onValueChange={(v) => v && setTool(v as any)}
                className="flex rounded-xl border border-white/10 bg-white/5 p-1 text-sm font-medium"
              >
                <ToggleGroupItem
                  value="select"
                  aria-label="Select/Move"
                  className="rounded-lg px-3 py-2 text-white/70 transition data-[state=on]:!bg-cyan-500 data-[state=on]:!text-white data-[state=on]:shadow-lg"
                >
                  Select
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="arrow-straight"
                  aria-label="Straight Arrow"
                  className="rounded-lg px-3 py-2 text-white/70 transition data-[state=on]:!bg-cyan-500 data-[state=on]:!text-white data-[state=on]:shadow-lg"
                >
                  →
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="arrow-curve"
                  aria-label="Curved Arrow"
                  className="rounded-lg px-3 py-2 text-white/70 transition data-[state=on]:!bg-cyan-500 data-[state=on]:!text-white data-[state=on]:shadow-lg"
                >
                  ⤳
                </ToggleGroupItem>
              </ToggleGroup>

              <Toggle
                pressed={currentDashed}
                onPressedChange={setCurrentDashed}
                variant="outline"
                className="rounded-full border-white/30 px-4 text-sm uppercase tracking-wide text-white/70 transition data-[state=on]:!bg-white/20 data-[state=on]:!text-white"
              >
                Dashed
              </Toggle>
            </div>

            <Separator className="my-4 bg-white/10" />

            <div className="flex flex-wrap items-center gap-3 text-sm text-white/80">
              <Label className="text-white/70">Arrow color</Label>
              <Toggle
                pressed={currentArrowColor === "redLine"}
                onPressedChange={(p) => p && setCurrentArrowColor("redLine")}
                className="h-8 w-8 rounded-full border border-white/25 transition data-[state=on]:ring-2 data-[state=on]:ring-white"
                style={{ background: COLORS.redLine }}
                aria-label="Red"
              />
              <Toggle
                pressed={currentArrowColor === "blueLine"}
                onPressedChange={(p) => p && setCurrentArrowColor("blueLine")}
                className="h-8 w-8 rounded-full border border-white/25 transition data-[state=on]:ring-2 data-[state=on]:ring-white"
                style={{ background: COLORS.blueLine }}
                aria-label="Blue"
              />
              <Toggle
                pressed={currentArrowColor === "yellow"}
                onPressedChange={(p) => p && setCurrentArrowColor("yellow")}
                className="h-8 w-8 rounded-full border border-white/25 transition data-[state=on]:ring-2 data-[state=on]:ring-white"
                style={{ background: COLORS.yellow }}
                aria-label="Yellow"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Export dialog */}
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Board state JSON</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded bg-neutral-100 p-3 text-xs text-neutral-900">
            {JSON.stringify(state, null, 2)}
          </pre>
          <DialogFooter>
            <Button
              onClick={() =>
                navigator.clipboard.writeText(JSON.stringify(state))
              }
            >
              Copy
            </Button>
            <DialogClose asChild>
              <Button variant="secondary">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Import Board JSON</DialogTitle>
          </DialogHeader>
          <textarea
            className="min-h-[40vh] w-full resize-y rounded border p-2 text-xs text-neutral-900"
            placeholder="Paste JSON here…"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <DialogFooter>
            <Button
              onClick={() => {
                try {
                  const parsed: BoardState = JSON.parse(importText);
                  const normalized = normalizeImportedElements(
                    parsed.elements ?? [],
                  );
                  replaceElements(normalized);
                  setCamera(parsed.camera ?? { x: 0, y: 0, scale: 1 });
                  setImportDialogOpen(false);
                } catch (e) {
                  alert("Invalid JSON");
                }
              }}
            >
              Load
            </Button>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Custom context menu for shape properties */}
      {ctxMenu.open && ctxTarget && (
        <div
          ref={ctxRef}
          className="fixed z-[100] min-w-[248px] rounded-2xl border border-neutral-900  bg-neutral-950/95 p-4 text-sm text-white shadow-[0_22px_55px_rgba(0,0,0,0.65)] backdrop-blur-md"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {ctxTarget.kind === "player" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-[0.3em] text-stone-200/80">
                  Player
                </span>
                {ctxTarget.name && (
                  <span className="text-xs text-white/40">
                    {ctxTarget.name}
                  </span>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <span className="text-xs font-medium text-white/60">
                    Color
                  </span>
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      type="button"
                      className={`h-6 w-6 rounded-full border transition-all duration-150 ${ctxTarget.color === "blue" ? "border-amber-300 ring-4 ring-amber-300/30" : "border-white/15 hover:border-amber-200/60"}`}
                      style={{ background: COLORS.blue }}
                      onClick={() =>
                        updateElement(ctxTarget.id, { color: "blue" })
                      }
                    />
                    <button
                      type="button"
                      className={`h-6 w-6 rounded-full border transition-all duration-150 ${ctxTarget.color === "red" ? "border-amber-300 ring-4 ring-amber-300/30" : "border-white/15 hover:border-amber-200/60"}`}
                      style={{ background: COLORS.red }}
                      onClick={() =>
                        updateElement(ctxTarget.id, { color: "red" })
                      }
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium uppercase tracking-[0.2em] text-white/55">
                    Avatar
                  </label>
                  <input
                    className="w-full rounded-lg border border-white/10 bg-neutral-900/60 px-3 py-1 text-sm text-white placeholder:text-white/40 focus:border-amber-400 focus:outline-none"
                    value={ctxTarget.avatar ?? ""}
                    onChange={(e) =>
                      updateElement(ctxTarget.id, {
                        avatar: e.target.value.slice(0, 2),
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium uppercase tracking-[0.2em] text-white/55">
                    Name
                  </label>
                  <input
                    className="w-full rounded-lg border border-white/10 bg-neutral-900/60 px-3 py-1 text-sm text-white placeholder:text-white/40 focus:border-amber-400 focus:outline-none"
                    value={ctxTarget.name ?? ""}
                    onChange={(e) =>
                      updateElement(ctxTarget.id, { name: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  variant="destructive"
                  size="sm"
                  className="!bg-gradient-to-r !from-rose-600 !to-red-500 !text-white px-4 py-1.5 text-xs font-semibold uppercase tracking-wide shadow-lg shadow-rose-900/60 transition hover:from-rose-500 hover:to-red-400"
                  onClick={() => {
                    deleteElement(ctxTarget.id);
                    closeCtx();
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          )}

          {ctxTarget.kind === "ball" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-[0.3em] text-stone-200/80">
                  Ball
                </span>
              </div>
              <div className="flex justify-end">
                <Button
                  variant="destructive"
                  size="sm"
                  className="!bg-gradient-to-r !from-rose-600 !to-red-500 !text-white px-4 py-1.5 text-xs font-semibold uppercase tracking-wide shadow-lg shadow-rose-900/60 transition hover:from-rose-500 hover:to-red-400"
                  onClick={() => {
                    deleteElement(ctxTarget.id);
                    closeCtx();
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          )}

          {(ctxTarget.kind === "arrow-straight" ||
            ctxTarget.kind === "arrow-curve") && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-[0.3em] text-stone-200/80">
                  Arrow
                </span>
              </div>
              <div className="space-y-3">
                <div>
                  <span className="text-xs font-medium text-white/60">
                    Color
                  </span>
                  <div className="mt-2 flex items-center gap-3">
                    {(["redLine", "blueLine", "yellow"] as ArrowColor[]).map(
                      (c) => (
                        <button
                          type="button"
                          key={c}
                          className={`h-6 w-6 rounded-full border transition-all duration-150 ${ctxTarget.color === c ? "border-amber-300 ring-4 ring-amber-300/30" : "border-white/15 hover:border-amber-200/60"}`}
                          style={{ background: COLORS[c] }}
                          onClick={() =>
                            updateElement(ctxTarget.id, { color: c })
                          }
                        />
                      ),
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-white/10 bg-neutral-900/50 px-3 py-2">
                  <span className="text-xs font-medium uppercase tracking-[0.2em] text-white/55">
                    Dashed
                  </span>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-amber-400"
                    checked={(ctxTarget as any).dashed}
                    onChange={(e) =>
                      updateElement(ctxTarget.id, { dashed: e.target.checked })
                    }
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  variant="destructive"
                  size="sm"
                  className="!bg-gradient-to-r !from-rose-600 !to-red-500 !text-white px-4 py-1.5 text-xs font-semibold uppercase tracking-wide shadow-lg shadow-rose-900/60 transition hover:from-rose-500 hover:to-red-400"
                  onClick={() => {
                    deleteElement(ctxTarget.id);
                    closeCtx();
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

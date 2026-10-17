import type { Metadata } from "next";
import { Models } from "@/components/models";

export const metadata: Metadata = {
  title: "D1A models",
  description: "D1A のモデル: E2B・E4B・計画中の 12B、ベースと指示調整版、判断とチャットを1つのモデルで、スコア、ビルド / The D1A models: E2B, E4B and the planned 12B, base and instruction-tuned trunks, decisions and chat in one model, scores and builds.",
};

export default function Page() {
  return <Models />;
}

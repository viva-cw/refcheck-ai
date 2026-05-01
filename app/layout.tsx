import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "RefCheck AI — AI-Powered Sports Officiating Analysis",
  description:
    "Upload a sports video clip and get an AI-powered, rule-based verdict on whether the referee's call was fair or incorrect. Powered by Gemini 1.5 Flash.",
  keywords: ["sports officiating", "referee review", "AI sports analysis", "fair call", "bad call"],
  openGraph: {
    title: "RefCheck AI",
    description: "AI-powered sports officiating analysis. Was it a fair call?",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-full bg-grid noise">{children}</body>
    </html>
  );
}

import { defineCollection, z } from "astro:content";

const articles = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sourceName: z.string(),
    sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sourceUrl: z.string().url().optional(),
    draft: z.boolean(),
    excerpt: z.string().optional(),
    answerQuestion: z.string(),
    answerText: z.string(),
    riskLevel: z.enum(["low", "medium", "high"]).optional()
  })
});

export const collections = { articles };

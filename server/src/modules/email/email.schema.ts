import { z } from 'zod';

function getQueryValueParts(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.flatMap(getQueryValueParts);
    }
    if (typeof value === 'string') {
        return value.split(',');
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return [String(value)];
    }
    return [];
}

const groupIdsQuerySchema = z.preprocess((value) => {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    return getQueryValueParts(value)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0);
}, z.array(z.number().int().positive()).optional());

const optionalBooleanQuerySchema = z.preprocess((value) => {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    const [rawValue] = getQueryValueParts(value);
    const normalized = (rawValue || '').trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
}, z.boolean().optional());

export const createEmailSchema = z.object({
    email: z.string().email(),
    clientId: z.string().min(1),
    refreshToken: z.string().min(1),
    password: z.string().optional(),
    groupId: z.coerce.number().int().positive().optional(),
});

export const updateEmailSchema = z.object({
    email: z.string().email().optional(),
    clientId: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    password: z.string().optional(),
    status: z.enum(['ACTIVE', 'ERROR', 'DISABLED']).optional(),
    groupId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
});

export const listEmailSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(10),
    status: z.enum(['ACTIVE', 'ERROR', 'DISABLED']).optional(),
    keyword: z.string().optional(),
    groupId: z.coerce.number().int().positive().optional(),
    groupIds: groupIdsQuerySchema,
    includeUngrouped: optionalBooleanQuerySchema,
    groupName: z.string().optional(),
});

export const importEmailSchema = z.object({
    content: z.string().min(1),
    separator: z.string().default('----'),
    groupId: z.coerce.number().int().positive().optional(),
});

export type CreateEmailInput = z.infer<typeof createEmailSchema>;
export type UpdateEmailInput = z.infer<typeof updateEmailSchema>;
export type ListEmailInput = z.infer<typeof listEmailSchema>;
export type ImportEmailInput = z.infer<typeof importEmailSchema>;
